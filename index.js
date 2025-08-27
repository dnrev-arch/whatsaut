const express = require('express');
const axios = require('axios');
const app = express();

// ============================================
// CONFIGURAÇÕES DO SISTEMA
// ============================================
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/whats-direct';
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'https://evo.flowzap.fun';
const PORT = process.env.PORT || 3000;

// Timeouts e intervalos
const CHECKPOINT_TIMEOUT = 24 * 60 * 60 * 1000; // 24 horas para responder
const DATA_RETENTION_TIME = 72 * 60 * 60 * 1000; // 72 horas retenção total
const CLEANUP_INTERVAL = 30 * 60 * 1000; // Limpeza a cada 30 minutos
const INSTANCE_ROTATION_RESET = 1000; // Reset contador a cada 1000 leads

// ============================================
// INSTÂNCIAS WHATSAPP DISPONÍVEIS
// ============================================
const INSTANCES = [
    { name: 'G08', id: 'A63C380B277D-4A5E-9ECD-48710291E5A6', active: true },
];

// ============================================
// ARMAZENAMENTO EM MEMÓRIA
// ============================================
let conversationState = new Map();      // Estado de cada conversa
let checkpointTimeouts = new Map();     // Timeouts ativos
let instanceStats = new Map();          // Estatísticas por instância
let systemLogs = [];                    // Logs do sistema
let checkpointHistory = [];             // Histórico de checkpoints
let dailyStats = {                      // Estatísticas diárias
    leads_today: 0,
    checkpoints_passed: 0,
    timeouts: 0,
    active_now: 0,
    last_reset: new Date()
};

// Contadores
let instanceRotationCounter = 0;
let totalLeadsProcessed = 0;

// ============================================
// CONFIGURAÇÃO DO EXPRESS
// ============================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// FUNÇÕES UTILITÁRIAS
// ============================================
function getBrazilTime() {
    return new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo'
    });
}

function getBrazilDate() {
    return new Date().toLocaleDateString('pt-BR', {
        timeZone: 'America/Sao_Paulo'
    });
}

function addLog(type, message, data = null) {
    const logEntry = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        timestamp: new Date().toISOString(),
        brazilTime: getBrazilTime(),
        type: type,
        message: message,
        data: data
    };
    
    systemLogs.unshift(logEntry);
    
    // Mantém apenas últimos 1000 logs
    if (systemLogs.length > 1000) {
        systemLogs = systemLogs.slice(0, 1000);
    }
    
    console.log(`[${logEntry.brazilTime}] ${type.toUpperCase()}: ${message}`);
    return logEntry;
}

// ============================================
// GERENCIAMENTO DE INSTÂNCIAS
// ============================================
function initializeInstanceStats() {
    INSTANCES.forEach(instance => {
        instanceStats.set(instance.name, {
            total_leads: 0,
            active_conversations: 0,
            checkpoints_passed: 0,
            timeouts: 0,
            last_activity: new Date(),
            health_score: 100,
            response_rate: 100,
            blocked: false
        });
    });
    addLog('system', 'Estatísticas de instâncias inicializadas');
}

function getNextInstance() {
    // Filtra apenas instâncias ativas e não bloqueadas
    const availableInstances = INSTANCES.filter(i => {
        const stats = instanceStats.get(i.name);
        return i.active && (!stats || !stats.blocked);
    });
    
    if (availableInstances.length === 0) {
        addLog('warning', 'Nenhuma instância disponível! Usando fallback');
        return INSTANCES[0];
    }
    
    // Round-robin entre instâncias disponíveis
    const instance = availableInstances[instanceRotationCounter % availableInstances.length];
    instanceRotationCounter++;
    
    // Reset contador periodicamente para evitar overflow
    if (instanceRotationCounter > INSTANCE_ROTATION_RESET) {
        instanceRotationCounter = 0;
    }
    
    // Atualiza estatísticas
    const stats = instanceStats.get(instance.name);
    if (stats) {
        stats.total_leads++;
        stats.active_conversations++;
        stats.last_activity = new Date();
        instanceStats.set(instance.name, stats);
    }
    
    return instance;
}

function updateInstanceStats(instanceName, event, data = {}) {
    const stats = instanceStats.get(instanceName);
    if (!stats) return;
    
    switch(event) {
        case 'checkpoint_passed':
            stats.checkpoints_passed++;
            stats.response_rate = Math.min(100, stats.response_rate + 0.5);
            stats.health_score = Math.min(100, stats.health_score + 1);
            break;
        case 'timeout':
            stats.timeouts++;
            stats.response_rate = Math.max(0, stats.response_rate - 2);
            stats.health_score = Math.max(0, stats.health_score - 3);
            break;
        case 'conversation_ended':
            stats.active_conversations = Math.max(0, stats.active_conversations - 1);
            break;
        case 'blocked':
            stats.blocked = true;
            stats.health_score = 0;
            addLog('error', `Instância ${instanceName} marcada como bloqueada`);
            break;
    }
    
    stats.last_activity = new Date();
    instanceStats.set(instanceName, stats);
}

// ============================================
// FUNÇÕES PRINCIPAIS DE CHECKPOINT
// ============================================
function createConversation(phone, name = 'Cliente', source = 'ads') {
    const instance = getNextInstance();
    
    const conversation = {
        phone: phone,
        name: name,
        instance: instance.name,
        instance_id: instance.id,
        source: source,
        current_checkpoint: null,
        checkpoints: [],
        waiting_response: false,
        created_at: new Date(),
        last_activity: new Date(),
        status: 'active'
    };
    
    conversationState.set(phone, conversation);
    
    totalLeadsProcessed++;
    dailyStats.leads_today++;
    dailyStats.active_now = conversationState.size;
    
    addLog('conversation', `Nova conversa: ${phone} → ${instance.name}`, conversation);
    
    return conversation;
}

function activateCheckpoint(phone, checkpointName, options = {}) {
    const conversation = conversationState.get(phone);
    
    if (!conversation) {
        addLog('error', `Tentativa de ativar checkpoint para conversa inexistente: ${phone}`);
        return { success: false, error: 'Conversa não encontrada' };
    }
    
    // Cancela checkpoint anterior se existir
    const timeoutKey = `${phone}_${conversation.current_checkpoint}`;
    if (checkpointTimeouts.has(timeoutKey)) {
        clearTimeout(checkpointTimeouts.get(timeoutKey));
        checkpointTimeouts.delete(timeoutKey);
    }
    
    // Configura novo checkpoint
    conversation.current_checkpoint = checkpointName;
    conversation.waiting_response = true;
    conversation.checkpoint_activated_at = new Date();
    conversation.last_activity = new Date();
    
    // Cria timeout para este checkpoint
    const timeoutMinutes = options.timeout_minutes || 1440; // 24h padrão
    const timeoutId = setTimeout(() => {
        handleCheckpointTimeout(phone, checkpointName);
    }, timeoutMinutes * 60 * 1000);
    
    checkpointTimeouts.set(`${phone}_${checkpointName}`, timeoutId);
    conversationState.set(phone, conversation);
    
    addLog('checkpoint', `Checkpoint '${checkpointName}' ativado para ${phone}`, {
        phone: phone,
        checkpoint: checkpointName,
        timeout: timeoutMinutes
    });
    
    return { 
        success: true, 
        checkpoint: checkpointName,
        instance: conversation.instance,
        instance_id: conversation.instance_id
    };
}

function handleCheckpointTimeout(phone, checkpointName) {
    const conversation = conversationState.get(phone);
    
    if (!conversation || conversation.current_checkpoint !== checkpointName) {
        return;
    }
    
    conversation.waiting_response = false;
    conversation.status = 'timeout';
    conversationState.set(phone, conversation);
    
    updateInstanceStats(conversation.instance, 'timeout');
    dailyStats.timeouts++;
    
    addLog('timeout', `Timeout checkpoint '${checkpointName}' para ${phone}`);
    
    // Notifica N8N sobre timeout
    notifyN8N({
        event: 'checkpoint_timeout',
        phone: phone,
        checkpoint: checkpointName,
        instance: conversation.instance
    });
}

function processCheckpointResponse(phone, message) {
    const conversation = conversationState.get(phone);
    
    if (!conversation) {
        return { success: false, error: 'Conversa não encontrada' };
    }
    
    if (!conversation.waiting_response) {
        addLog('info', `Resposta ignorada - ${phone} não aguardava resposta`);
        return { success: false, error: 'Não aguardava resposta' };
    }
    
    const checkpointName = conversation.current_checkpoint;
    
    // Cancela timeout
    const timeoutKey = `${phone}_${checkpointName}`;
    if (checkpointTimeouts.has(timeoutKey)) {
        clearTimeout(checkpointTimeouts.get(timeoutKey));
        checkpointTimeouts.delete(timeoutKey);
    }
    
    // Registra checkpoint passado
    const checkpointData = {
        name: checkpointName,
        response: message,
        passed_at: new Date(),
        response_time: new Date() - conversation.checkpoint_activated_at
    };
    
    conversation.checkpoints.push(checkpointData);
    conversation.waiting_response = false;
    conversation.last_activity = new Date();
    conversationState.set(phone, conversation);
    
    // Atualiza estatísticas
    updateInstanceStats(conversation.instance, 'checkpoint_passed');
    dailyStats.checkpoints_passed++;
    
    // Adiciona ao histórico
    checkpointHistory.unshift({
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        phone: phone,
        name: conversation.name,
        checkpoint: checkpointName,
        response: message,
        instance: conversation.instance,
        timestamp: new Date(),
        brazil_time: getBrazilTime()
    });
    
    // Mantém apenas últimos 500 registros
    if (checkpointHistory.length > 500) {
        checkpointHistory = checkpointHistory.slice(0, 500);
    }
    
    addLog('checkpoint', `✅ ${phone} passou checkpoint '${checkpointName}'`, checkpointData);
    
    return {
        success: true,
        checkpoint: checkpointName,
        response: message,
        instance: conversation.instance
    };
}

// ============================================
// COMUNICAÇÃO COM N8N
// ============================================
async function notifyN8N(data) {
    try {
        const payload = {
            ...data,
            timestamp: new Date().toISOString(),
            brazil_time: getBrazilTime()
        };
        
        const response = await axios.post(N8N_WEBHOOK_URL, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        });
        
        addLog('n8n', `Evento '${data.event}' enviado para N8N`, payload);
        return { success: true, response: response.data };
        
    } catch (error) {
        addLog('error', `Falha ao notificar N8N: ${error.message}`, error);
        return { success: false, error: error.message };
    }
}

// ============================================
// ENDPOINTS DA API
// ============================================

// Recebe novo lead (do anúncio ou redirecionador)
app.post('/api/lead/new', async (req, res) => {
    try {
        const { phone, name = 'Cliente', message = '', source = 'ads' } = req.body;
        
        if (!phone) {
            return res.status(400).json({ success: false, error: 'Telefone obrigatório' });
        }
        
        // Verifica se já existe conversa
        if (conversationState.has(phone)) {
            const existing = conversationState.get(phone);
            addLog('info', `Lead ${phone} já tem conversa ativa`);
            
            return res.json({
                success: true,
                status: 'existing',
                conversation: {
                    instance: existing.instance,
                    instance_id: existing.instance_id,
                    created_at: existing.created_at
                }
            });
        }
        
        // Cria nova conversa
        const conversation = createConversation(phone, name, source);
        
        // Notifica N8N para iniciar fluxo
        await notifyN8N({
            event: 'new_lead',
            phone: phone,
            name: name,
            instance: conversation.instance,
            instance_id: conversation.instance_id,
            initial_message: message,
            source: source
        });
        
        res.json({
            success: true,
            status: 'created',
            conversation: {
                phone: phone,
                instance: conversation.instance,
                instance_id: conversation.instance_id
            }
        });
        
    } catch (error) {
        addLog('error', `Erro ao criar lead: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Ativar checkpoint (chamado pelo N8N)
app.post('/api/checkpoint/activate', async (req, res) => {
    try {
        const { phone, checkpoint_name, timeout_minutes = 1440 } = req.body;
        
        if (!phone || !checkpoint_name) {
            return res.status(400).json({ 
                success: false, 
                error: 'phone e checkpoint_name são obrigatórios' 
            });
        }
        
        const result = activateCheckpoint(phone, checkpoint_name, { timeout_minutes });
        
        if (!result.success) {
            return res.status(404).json(result);
        }
        
        res.json(result);
        
    } catch (error) {
        addLog('error', `Erro ao ativar checkpoint: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Consultar status de conversa
app.get('/api/conversation/:phone', (req, res) => {
    const { phone } = req.params;
    const conversation = conversationState.get(phone);
    
    if (!conversation) {
        return res.status(404).json({ success: false, error: 'Conversa não encontrada' });
    }
    
    res.json({
        success: true,
        conversation: {
            ...conversation,
            checkpoints_count: conversation.checkpoints.length
        }
    });
});

// Webhook Evolution - Recebe TODAS mensagens
app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        
        // Valida estrutura
        const messageData = data.data;
        if (!messageData || !messageData.key) {
            return res.status(200).json({ success: true });
        }
        
        // Extrai dados
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageContent = messageData.message?.conversation || 
                              messageData.message?.extendedTextMessage?.text || '';
        
        // Remove sufixo do WhatsApp
        const phone = remoteJid.replace('@s.whatsapp.net', '');
        
        // Ignora mensagens do bot
        if (fromMe) {
            return res.status(200).json({ success: true });
        }
        
        // Ignora mensagens vazias
        if (!messageContent.trim()) {
            return res.status(200).json({ success: true });
        }
        
        // Log da mensagem recebida
        addLog('evolution', `Mensagem de ${phone}: "${messageContent.substring(0, 50)}..."`);
        
        // NOVA LÓGICA: Verifica se é lead novo (número desconhecido)
        if (!conversationState.has(phone)) {
            // CRIA LEAD AUTOMATICAMENTE
            const conversation = createConversation(phone, 'Cliente', 'whatsapp_direto');
            
            addLog('auto_lead', `Lead criado automaticamente: ${phone}`, {
                phone: phone,
                initial_message: messageContent,
                instance: conversation.instance
            });
            
            // Notifica N8N como new_lead para iniciar o fluxo
            await notifyN8N({
                event: 'new_lead',
                phone: phone,
                name: 'Cliente',
                instance: conversation.instance,
                instance_id: conversation.instance_id,
                initial_message: messageContent,
                source: 'whatsapp_direto'
            });
            
            return res.status(200).json({ success: true, status: 'new_lead_created' });
        }
        
        // LÓGICA EXISTENTE: Processa resposta de checkpoint se houver conversa ativa
        const result = processCheckpointResponse(phone, messageContent);
        
        if (result.success) {
            // Notifica N8N que checkpoint foi passado
            await notifyN8N({
                event: 'checkpoint_passed',
                phone: phone,
                checkpoint: result.checkpoint,
                response: result.response,
                instance: result.instance
            });
        }
        
        res.status(200).json({ success: true });
        
    } catch (error) {
        addLog('error', `Erro no webhook Evolution: ${error.message}`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint para marcar instância como bloqueada
app.post('/api/instance/block', (req, res) => {
    const { instance_name } = req.body;
    
    const instance = INSTANCES.find(i => i.name === instance_name);
    if (!instance) {
        return res.status(404).json({ success: false, error: 'Instância não encontrada' });
    }
    
    instance.active = false;
    updateInstanceStats(instance_name, 'blocked');
    
    addLog('warning', `Instância ${instance_name} marcada como bloqueada`);
    
    res.json({ success: true, message: `Instância ${instance_name} bloqueada` });
});

// Status geral do sistema
app.get('/api/status', (req, res) => {
    const conversations = Array.from(conversationState.entries()).map(([phone, conv]) => ({
        phone: phone,
        name: conv.name,
        instance: conv.instance,
        status: conv.status,
        current_checkpoint: conv.current_checkpoint,
        checkpoints_passed: conv.checkpoints.length,
        waiting_response: conv.waiting_response,
        created_at: conv.created_at,
        last_activity: conv.last_activity
    }));
    
    const instances = Array.from(instanceStats.entries()).map(([name, stats]) => ({
        name: name,
        ...stats,
        active: INSTANCES.find(i => i.name === name)?.active || false
    }));
    
    res.json({
        system: {
            status: 'online',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            brazil_time: getBrazilTime()
        },
        stats: {
            ...dailyStats,
            total_leads_processed: totalLeadsProcessed,
            active_conversations: conversationState.size,
            active_checkpoints: checkpointTimeouts.size
        },
        conversations: conversations,
        instances: instances,
        recent_checkpoints: checkpointHistory.slice(0, 50),
        recent_logs: systemLogs.slice(0, 100)
    });
});

// ============================================
// LIMPEZA AUTOMÁTICA
// ============================================
function cleanupOldData() {
    const now = Date.now();
    let cleaned = 0;
    
    // Remove conversas antigas
    for (const [phone, conv] of conversationState.entries()) {
        if (now - conv.last_activity > DATA_RETENTION_TIME) {
            conversationState.delete(phone);
            
            // Cancela timeouts pendentes
            const timeoutKey = `${phone}_${conv.current_checkpoint}`;
            if (checkpointTimeouts.has(timeoutKey)) {
                clearTimeout(checkpointTimeouts.get(timeoutKey));
                checkpointTimeouts.delete(timeoutKey);
            }
            
            updateInstanceStats(conv.instance, 'conversation_ended');
            cleaned++;
        }
    }
    
    // Limpa logs antigos
    systemLogs = systemLogs.filter(log => 
        new Date(log.timestamp).getTime() > now - DATA_RETENTION_TIME
    );
    
    // Limpa histórico antigo
    checkpointHistory = checkpointHistory.filter(h => 
        h.timestamp.getTime() > now - DATA_RETENTION_TIME
    );
    
    // Reset estatísticas diárias à meia-noite
    const today = new Date().toDateString();
    if (new Date(dailyStats.last_reset).toDateString() !== today) {
        dailyStats = {
            leads_today: 0,
            checkpoints_passed: 0,
            timeouts: 0,
            active_now: conversationState.size,
            last_reset: new Date()
        };
        addLog('system', 'Estatísticas diárias resetadas');
    }
    
    dailyStats.active_now = conversationState.size;
    
    if (cleaned > 0) {
        addLog('cleanup', `Limpeza: ${cleaned} conversas removidas`);
    }
}

// ============================================
// DASHBOARD HTML
// ============================================
app.get('/', (req, res) => {
    res.send(getHTMLDashboard());
});

function getHTMLDashboard() {
    return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🧠 Sistema Multi-Checkpoint WhatsApp</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        :root {
            --primary: #25D366;
            --primary-dark: #128C7E;
            --secondary: #075E54;
            --success: #48bb78;
            --warning: #ed8936;
            --danger: #f56565;
            --info: #4299e1;
            --dark: #2d3748;
            --gray: #718096;
            --light: #f7fafc;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container { max-width: 1600px; margin: 0 auto; }
        
        .header {
            background: white;
            border-radius: 20px;
            padding: 30px;
            margin-bottom: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        
        h1 {
            color: var(--dark);
            font-size: 2.5rem;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 15px;
        }
        
        .subtitle {
            color: var(--gray);
            font-size: 1.1rem;
            margin-bottom: 20px;
        }
        
        .config-info {
            background: var(--light);
            border-radius: 10px;
            padding: 15px;
            margin: 20px 0;
        }
        
        .config-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid #e0e0e0;
        }
        
        .config-row:last-child { border: none; }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card {
            background: white;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.08);
            transition: transform 0.3s ease;
        }
        
        .stat-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 15px 35px rgba(0,0,0,0.12);
        }
        
        .stat-card.primary { border-left: 4px solid var(--primary); }
        .stat-card.success { border-left: 4px solid var(--success); }
        .stat-card.warning { border-left: 4px solid var(--warning); }
        .stat-card.info { border-left: 4px solid var(--info); }
        
        .stat-label {
            font-size: 0.9rem;
            color: var(--gray);
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .stat-value {
            font-size: 2.5rem;
            font-weight: 700;
            color: var(--dark);
        }
        
        .stat-change {
            font-size: 0.85rem;
            color: var(--gray);
            margin-top: 5px;
        }
        
        .controls {
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
            margin-bottom: 30px;
        }
        
        .btn {
            background: var(--primary);
            color: white;
            border: none;
            padding: 12px 25px;
            border-radius: 25px;
            cursor: pointer;
            font-weight: 600;
            transition: all 0.3s ease;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        
        .btn:hover {
            background: var(--primary-dark);
            transform: translateY(-2px);
            box-shadow: 0 10px 25px rgba(37, 211, 102, 0.4);
        }
        
        .btn-secondary { background: var(--gray); }
        .btn-danger { background: var(--danger); }
        
        .content-panel {
            background: white;
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            margin-bottom: 30px;
        }
        
        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            border-bottom: 2px solid var(--light);
        }
        
        .tab {
            padding: 12px 24px;
            background: none;
            border: none;
            color: var(--gray);
            font-weight: 600;
            cursor: pointer;
            position: relative;
            transition: color 0.3s ease;
        }
        
        .tab.active {
            color: var(--primary);
        }
        
        .tab.active::after {
            content: '';
            position: absolute;
            bottom: -2px;
            left: 0;
            right: 0;
            height: 2px;
            background: var(--primary);
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
        }
        
        th {
            background: var(--light);
            padding: 12px;
            text-align: left;
            font-weight: 600;
            color: var(--dark);
            font-size: 0.9rem;
        }
        
        td {
            padding: 12px;
            border-bottom: 1px solid var(--light);
        }
        
        tr:hover { background: #f8f9fa; }
        
        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.8rem;
            font-weight: 600;
        }
        
        .badge-success { background: #c6f6d5; color: #22543d; }
        .badge-warning { background: #fbd38d; color: #975a16; }
        .badge-danger { background: #fed7d7; color: #742a2a; }
        .badge-info { background: #bee3f8; color: #2c5282; }
        .badge-primary { background: #d4f8e8; color: #065f46; }
        
        .instance-card {
            background: var(--light);
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .instance-info h4 { margin-bottom: 5px; }
        .instance-stats { display: flex; gap: 20px; }
        .instance-stat { text-align: center; }
        .instance-stat-value { font-size: 1.5rem; font-weight: bold; }
        .instance-stat-label { font-size: 0.8rem; color: var(--gray); }
        
        .health-bar {
            width: 100px;
            height: 8px;
            background: #e0e0e0;
            border-radius: 4px;
            overflow: hidden;
        }
        
        .health-fill {
            height: 100%;
            transition: width 0.3s ease;
        }
        
        .health-fill.good { background: var(--success); }
        .health-fill.warning { background: var(--warning); }
        .health-fill.danger { background: var(--danger); }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--gray);
        }
        
        .empty-state i {
            font-size: 4rem;
            margin-bottom: 20px;
            opacity: 0.3;
        }
        
        .loading {
            text-align: center;
            padding: 40px;
        }
        
        .spinner {
            border: 3px solid var(--light);
            border-top: 3px solid var(--primary);
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        @media (max-width: 768px) {
            body { padding: 10px; }
            h1 { font-size: 1.8rem; }
            .stats-grid { grid-template-columns: 1fr; }
            .controls { flex-direction: column; }
            .tabs { overflow-x: auto; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>
                <i class="fab fa-whatsapp"></i>
                Sistema Multi-Checkpoint WhatsApp
            </h1>
            <div class="subtitle">Gerenciamento inteligente de conversas com múltiplos pontos de parada - AUTO LEAD</div>
            
            <div class="config-info">
                <div class="config-row">
                    <span><strong>N8N Webhook:</strong></span>
                    <span id="n8n-url">${N8N_WEBHOOK_URL}</span>
                </div>
                <div class="config-row">
                    <span><strong>Timeout Checkpoint:</strong></span>
                    <span>24 horas</span>
                </div>
                <div class="config-row">
                    <span><strong>Retenção de Dados:</strong></span>
                    <span>72 horas</span>
                </div>
                <div class="config-row">
                    <span><strong>Status:</strong></span>
                    <span class="badge badge-success">Online</span>
                </div>
                <div class="config-row">
                    <span><strong>Modo:</strong></span>
                    <span class="badge badge-info">Auto Lead</span>
                </div>
                <div class="config-row">
                    <span><strong>Horário:</strong></span>
                    <span id="current-time">--</span>
                </div>
            </div>
            
            <div class="stats-grid" id="main-stats">
                <div class="stat-card primary">
                    <div class="stat-label"><i class="fas fa-users"></i> Leads Hoje</div>
                    <div class="stat-value" id="leads-today">0</div>
                    <div class="stat-change">Total processados</div>
                </div>
                
                <div class="stat-card success">
                    <div class="stat-label"><i class="fas fa-check-circle"></i> Checkpoints Passados</div>
                    <div class="stat-value" id="checkpoints-passed">0</div>
                    <div class="stat-change">Respostas recebidas</div>
                </div>
                
                <div class="stat-card warning">
                    <div class="stat-label"><i class="fas fa-comments"></i> Conversas Ativas</div>
                    <div class="stat-value" id="active-conversations">0</div>
                    <div class="stat-change">Aguardando resposta</div>
                </div>
                
                <div class="stat-card info">
                    <div class="stat-label"><i class="fas fa-clock"></i> Timeouts</div>
                    <div class="stat-value" id="timeouts">0</div>
                    <div class="stat-change">Sem resposta em 24h</div>
                </div>
            </div>
            
            <div class="controls">
                <button class="btn" onclick="refreshData()">
                    <i class="fas fa-sync-alt"></i> Atualizar
                </button>
                <button class="btn btn-secondary" onclick="exportData()">
                    <i class="fas fa-download"></i> Exportar
                </button>
                <button class="btn btn-danger" onclick="clearOldData()">
                    <i class="fas fa-trash"></i> Limpar Antigos
                </button>
            </div>
        </div>
        
        <div class="content-panel">
            <div class="tabs">
                <button class="tab active" onclick="switchTab('conversations')">
                    <i class="fas fa-comments"></i> Conversas
                </button>
                <button class="tab" onclick="switchTab('instances')">
                    <i class="fas fa-server"></i> Instâncias
                </button>
                <button class="tab" onclick="switchTab('checkpoints')">
                    <i class="fas fa-tasks"></i> Checkpoints
                </button>
                <button class="tab" onclick="switchTab('logs')">
                    <i class="fas fa-file-alt"></i> Logs
                </button>
            </div>
            
            <div id="tab-content">
                <div class="loading">
                    <div class="spinner"></div>
                    <p>Carregando...</p>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        let currentTab = 'conversations';
        let systemData = null;
        
        // Atualiza relógio
        function updateClock() {
            const now = new Date();
            const brazilTime = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
            document.getElementById('current-time').textContent = brazilTime;
        }
        setInterval(updateClock, 1000);
        updateClock();
        
        // Alternar abas
        function switchTab(tab) {
            currentTab = tab;
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');
            renderTabContent();
        }
        
        // Renderizar conteúdo da aba
        function renderTabContent() {
            const content = document.getElementById('tab-content');
            
            if (!systemData) {
                content.innerHTML = '<div class="loading"><div class="spinner"></div><p>Carregando...</p></div>';
                return;
            }
            
            switch(currentTab) {
                case 'conversations':
                    renderConversations();
                    break;
                case 'instances':
                    renderInstances();
                    break;
                case 'checkpoints':
                    renderCheckpoints();
                    break;
                case 'logs':
                    renderLogs();
                    break;
            }
        }
        
        // Renderizar conversas
        function renderConversations() {
            const content = document.getElementById('tab-content');
            
            if (!systemData.conversations || systemData.conversations.length === 0) {
                content.innerHTML = '<div class="empty-state"><i class="fas fa-comments"></i><h3>Nenhuma conversa ativa</h3><p>As conversas aparecerão aqui quando iniciadas automaticamente</p></div>';
                return;
            }
            
            let html = '<table><thead><tr>';
            html += '<th>Telefone</th><th>Nome</th><th>Instância</th><th>Checkpoint Atual</th>';
            html += '<th>Checkpoints Passados</th><th>Status</th><th>Última Atividade</th>';
            html += '</tr></thead><tbody>';
            
            systemData.conversations.forEach(conv => {
                const statusBadge = conv.waiting_response ? 'warning' : 'success';
                const statusText = conv.waiting_response ? 'Aguardando' : 'Ativo';
                
                html += '<tr>';
                html += '<td>' + conv.phone + '</td>';
                html += '<td>' + conv.name + '</td>';
                html += '<td><span class="badge badge-primary">' + conv.instance + '</span></td>';
                html += '<td>' + (conv.current_checkpoint || '-') + '</td>';
                html += '<td>' + conv.checkpoints_passed + '</td>';
                html += '<td><span class="badge badge-' + statusBadge + '">' + statusText + '</span></td>';
                html += '<td>' + new Date(conv.last_activity).toLocaleString('pt-BR') + '</td>';
                html += '</tr>';
            });
            
            html += '</tbody></table>';
            content.innerHTML = html;
        }
        
        // Renderizar instâncias
        function renderInstances() {
            const content = document.getElementById('tab-content');
            
            if (!systemData.instances || systemData.instances.length === 0) {
                content.innerHTML = '<div class="empty-state"><i class="fas fa-server"></i><h3>Nenhuma instância configurada</h3></div>';
                return;
            }
            
            let html = '<div>';
            
            systemData.instances.forEach(inst => {
                const healthClass = inst.health_score > 70 ? 'good' : inst.health_score > 30 ? 'warning' : 'danger';
                const statusBadge = inst.active ? 'success' : 'danger';
                const statusText = inst.active ? 'Ativa' : 'Bloqueada';
                
                html += '<div class="instance-card">';
                html += '<div class="instance-info">';
                html += '<h4>' + inst.name + ' <span class="badge badge-' + statusBadge + '">' + statusText + '</span></h4>';
                html += '<div>Saúde: <div class="health-bar"><div class="health-fill ' + healthClass + '" style="width: ' + inst.health_score + '%"></div></div></div>';
                html += '</div>';
                html += '<div class="instance-stats">';
                html += '<div class="instance-stat"><div class="instance-stat-value">' + inst.total_leads + '</div><div class="instance-stat-label">Leads</div></div>';
                html += '<div class="instance-stat"><div class="instance-stat-value">' + inst.active_conversations + '</div><div class="instance-stat-label">Ativas</div></div>';
                html += '<div class="instance-stat"><div class="instance-stat-value">' + inst.checkpoints_passed + '</div><div class="instance-stat-label">Checkpoints</div></div>';
                html += '<div class="instance-stat"><div class="instance-stat-value">' + inst.timeouts + '</div><div class="instance-stat-label">Timeouts</div></div>';
                html += '</div>';
                html += '</div>';
            });
            
            html += '</div>';
            content.innerHTML = html;
        }
        
        // Renderizar checkpoints
        function renderCheckpoints() {
            const content = document.getElementById('tab-content');
            
            if (!systemData.recent_checkpoints || systemData.recent_checkpoints.length === 0) {
                content.innerHTML = '<div class="empty-state"><i class="fas fa-tasks"></i><h3>Nenhum checkpoint registrado</h3><p>Os checkpoints passados aparecerão aqui</p></div>';
                return;
            }
            
            let html = '<table><thead><tr>';
            html += '<th>Horário</th><th>Telefone</th><th>Nome</th><th>Checkpoint</th><th>Resposta</th><th>Instância</th>';
            html += '</tr></thead><tbody>';
            
            systemData.recent_checkpoints.forEach(cp => {
                html += '<tr>';
                html += '<td>' + cp.brazil_time + '</td>';
                html += '<td>' + cp.phone + '</td>';
                html += '<td>' + cp.name + '</td>';
                html += '<td><span class="badge badge-info">' + cp.checkpoint + '</span></td>';
                html += '<td>' + (cp.response ? cp.response.substring(0, 50) + '...' : '-') + '</td>';
                html += '<td><span class="badge badge-primary">' + cp.instance + '</span></td>';
                html += '</tr>';
            });
            
            html += '</tbody></table>';
            content.innerHTML = html;
        }
        
        // Renderizar logs
        function renderLogs() {
            const content = document.getElementById('tab-content');
            
            if (!systemData.recent_logs || systemData.recent_logs.length === 0) {
                content.innerHTML = '<div class="empty-state"><i class="fas fa-file-alt"></i><h3>Nenhum log disponível</h3></div>';
                return;
            }
            
            let html = '<table><thead><tr><th>Horário</th><th>Tipo</th><th>Mensagem</th></tr></thead><tbody>';
            
            systemData.recent_logs.forEach(log => {
                const badgeClass = log.type === 'error' ? 'danger' : 
                                   log.type === 'warning' ? 'warning' : 
                                   log.type === 'success' ? 'success' : 'info';
                
                html += '<tr>';
                html += '<td>' + log.brazilTime + '</td>';
                html += '<td><span class="badge badge-' + badgeClass + '">' + log.type + '</span></td>';
                html += '<td>' + log.message + '</td>';
                html += '</tr>';
            });
            
            html += '</tbody></table>';
            content.innerHTML = html;
        }
        
        // Atualizar dados
        async function refreshData() {
            try {
                const response = await fetch('/api/status');
                systemData = await response.json();
                
                // Atualizar estatísticas
                document.getElementById('leads-today').textContent = systemData.stats.leads_today;
                document.getElementById('checkpoints-passed').textContent = systemData.stats.checkpoints_passed;
                document.getElementById('active-conversations').textContent = systemData.stats.active_conversations;
                document.getElementById('timeouts').textContent = systemData.stats.timeouts;
                
                // Renderizar aba atual
                renderTabContent();
            } catch (error) {
                console.error('Erro ao atualizar dados:', error);
            }
        }
        
        // Exportar dados
        function exportData() {
            if (!systemData) return;
            
            const dataStr = JSON.stringify(systemData, null, 2);
            const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
            
            const exportFileDefaultName = 'checkpoint_data_' + new Date().toISOString().split('T')[0] + '.json';
            
            const linkElement = document.createElement('a');
            linkElement.setAttribute('href', dataUri);
            linkElement.setAttribute('download', exportFileDefaultName);
            linkElement.click();
        }
        
        // Limpar dados antigos
        async function clearOldData() {
            if (confirm('Deseja realmente limpar dados antigos?')) {
                // Aqui você pode adicionar uma chamada para um endpoint de limpeza
                alert('Limpeza automática já está configurada a cada 30 minutos');
            }
        }
        
        // Inicialização
        document.addEventListener('DOMContentLoaded', function() {
            refreshData();
            setInterval(refreshData, 10000); // Atualiza a cada 10 segundos
        });
    </script>
</body>
</html>
    `;
}

// ============================================
// INICIALIZAÇÃO DO SISTEMA
// ============================================
initializeInstanceStats();

// Configura limpeza automática
setInterval(cleanupOldData, CLEANUP_INTERVAL);

// Inicia servidor
app.listen(PORT, () => {
    console.log('\n=====================================');
    console.log('🧠 SISTEMA MULTI-CHECKPOINT WHATSAPP');
    console.log('=====================================');
    console.log(`✅ Servidor rodando na porta ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`📡 N8N Webhook: ${N8N_WEBHOOK_URL}`);
    console.log('\n📌 ENDPOINTS DISPONÍVEIS:');
    console.log('-------------------------------------');
    console.log('POST /api/lead/new              - Recebe novo lead');
    console.log('POST /api/checkpoint/activate   - Ativa checkpoint');
    console.log('GET  /api/conversation/:phone   - Status da conversa');
    console.log('POST /webhook/evolution         - Webhook Evolution');
    console.log('POST /api/instance/block        - Bloquear instância');
    console.log('GET  /api/status                - Status geral');
    console.log('-------------------------------------');
    console.log(`\n⏰ Horário: ${getBrazilTime()}`);
    console.log(`🔄 Limpeza automática: a cada ${CLEANUP_INTERVAL / 60000} minutos`);
    console.log(`💾 Retenção de dados: ${DATA_RETENTION_TIME / 3600000} horas`);
    console.log(`⏱️ Timeout checkpoint: ${CHECKPOINT_TIMEOUT / 3600000} horas`);
    console.log('\n🚀 MODO AUTO LEAD ATIVADO!');
    console.log('📱 Qualquer mensagem = Lead automático');
    console.log('=====================================\n');
    
    addLog('system', 'Sistema iniciado com AUTO LEAD ativado', {
        port: PORT,
        instances: INSTANCES.length,
        n8n_webhook: N8N_WEBHOOK_URL,
        mode: 'auto_lead'
    });
});
