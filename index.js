const express = require('express');
const axios = require('axios');
const app = express();

// Configurações
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/multi-checkpoint';
const EVOLUTION_API_URL = 'https://evo.flowzap.fun';
const CHECKPOINT_TIMEOUT = 24 * 60 * 60 * 1000; // 24 horas para responder
const DATA_RETENTION_TIME = 48 * 60 * 60 * 1000; // 48 horas retenção total
const CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutos cleanup

// Armazenamento em memória (depois migraremos para banco)
let conversationState = new Map(); // { phone: { checkpoints, current_step, etc } }
let clientInstanceMap = new Map(); // { phone: instance }
let systemLogs = [];
let checkpointHistory = []; // Histórico de todos os checkpoints
let instanceStats = new Map(); // Estatísticas por instância
let instanceCounter = 0;

// Instâncias disponíveis - ID é a própria API Key (igual ao projeto anterior)
const INSTANCES = [
    { name: 'G01', id: '584F8ACCAA48-488D-A26E-E75E1A5B2994' }, // id = apikey
    { name: 'G02', id: '2E2C41AB88F9-4356-B866-9ADA88530FD0' },
    { name: 'G03', id: '9AFECAC9683B-4611-8C51-933447B70905' },
    { name: 'G04', id: 'C974682BB258-4756-98F0-CF6D90FC2755' },
    { name: 'G05', id: '118E0162F12C-4841-ADD6-33E11DDB341A' },
    { name: 'G06', id: '4AC271E7BBEA-4A2B-BB2D-3583BDE4AE1E' },
    { name: 'G07T', id: 'E28170C3375C-4116-8723-144CC9B90994' },
    { name: 'G09', id: 'E667206D3C72-4F8B-AD10-F933F273A39B' },
    { name: 'G10', id: 'D6932E02E658-40BD-9784-8932841CCFA4' },
    { name: 'G11', id: 'A1A28E54D712-41B9-A682-A49072EA2C0B' },
];

app.use(express.json());

// Função para obter data/hora em Brasília
function getBrazilTime() {
    return new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo'
    });
}

// Função para adicionar logs
function addLog(type, message, data = null) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        brazilTime: getBrazilTime(),
        type: type,
        message: message,
        data: data
    };
    
    systemLogs.push(logEntry);
    console.log(`[${logEntry.brazilTime}] ${type.toUpperCase()}: ${message}`);
}

// ========== SISTEMA DE ROTAÇÃO INTELIGENTE DE INSTÂNCIAS ==========
function initializeInstanceStats() {
    INSTANCES.forEach(instance => {
        instanceStats.set(instance.name, {
            total_leads: 0,
            active_conversations: 0,
            completed_conversations: 0,
            response_rate: 100, // Começa com 100%
            last_activity: new Date(),
            health_score: 100, // Score de saúde (0-100)
            blocked: false
        });
    });
}

function updateInstanceStats(instanceName, action, data = {}) {
    const stats = instanceStats.get(instanceName);
    if (!stats) return;
    
    switch(action) {
        case 'new_lead':
            stats.total_leads++;
            stats.active_conversations++;
            stats.last_activity = new Date();
            break;
        case 'response_received':
            // Melhora response_rate
            const currentRate = stats.response_rate;
            stats.response_rate = Math.min(100, currentRate + 0.5);
            stats.health_score = Math.min(100, stats.health_score + 1);
            break;
        case 'no_response':
            // Piora response_rate
            stats.response_rate = Math.max(0, stats.response_rate - 2);
            stats.health_score = Math.max(0, stats.health_score - 5);
            break;
        case 'conversation_complete':
            stats.active_conversations--;
            stats.completed_conversations++;
            break;
        case 'blocked':
            stats.blocked = true;
            stats.health_score = 0;
            break;
    }
    
    instanceStats.set(instanceName, stats);
}

function getBestInstance() {
    let bestInstance = null;
    let bestScore = -1;
    
    for (const [instanceName, stats] of instanceStats.entries()) {
        if (stats.blocked) continue; // Pula instâncias bloqueadas
        
        // Calcula score baseado em múltiplos fatores
        const loadFactor = Math.max(0, 100 - (stats.active_conversations * 2)); // Penaliza sobrecarga
        const responseFactor = stats.response_rate;
        const healthFactor = stats.health_score;
        const timeFactor = (Date.now() - stats.last_activity.getTime()) < 300000 ? 10 : 0; // Bonus se ativa recentemente
        
        const finalScore = (loadFactor * 0.4) + (responseFactor * 0.3) + (healthFactor * 0.2) + (timeFactor * 0.1);
        
        if (finalScore > bestScore) {
            bestScore = finalScore;
            bestInstance = instanceName;
        }
    }
    
    // Fallback para round-robin se algo der errado
    if (!bestInstance) {
        bestInstance = INSTANCES[instanceCounter % INSTANCES.length].name;
        instanceCounter++;
    }
    
    return bestInstance;
}

// ========== SISTEMA DE MÚLTIPLOS CHECKPOINTS ==========

// Estrutura de um estado de conversa com checkpoints
function createConversationState(clientPhone, clientName, instanceName) {
    return {
        client_phone: clientPhone,
        client_name: clientName,
        instance: instanceName,
        current_checkpoint: null, // Qual checkpoint está aguardando
        checkpoint_history: [], // Histórico de checkpoints passados
        responses: [], // Respostas do cliente
        created_at: new Date(),
        last_activity: new Date(),
        expires_at: new Date(Date.now() + CHECKPOINT_TIMEOUT),
        status: 'active', // active, completed, expired, blocked
        total_checkpoints_passed: 0,
        waiting_for_response: false
    };
}

// Ativar um checkpoint específico
function activateCheckpoint(clientPhone, checkpointId, data = {}) {
    const state = conversationState.get(clientPhone);
    if (!state) {
        addLog('error', `Tentativa de ativar checkpoint ${checkpointId} para cliente inexistente: ${clientPhone}`);
        return { success: false, error: 'Cliente não encontrado' };
    }
    
    // Atualiza estado
    state.current_checkpoint = checkpointId;
    state.waiting_for_response = true;
    state.last_activity = new Date();
    state.expires_at = new Date(Date.now() + CHECKPOINT_TIMEOUT); // Reset timer
    
    // Adiciona dados extras se fornecidos
    if (data.message) state.last_system_message = data.message;
    if (data.step_data) state.step_data = data.step_data;
    
    conversationState.set(clientPhone, state);
    
    addLog('checkpoint', `Checkpoint ${checkpointId} ATIVADO para ${clientPhone} (${state.client_name})`);
    
    return { success: true, checkpoint: checkpointId, client: clientPhone };
}

// Processar resposta do cliente (passa pelo checkpoint)
function processClientResponse(clientPhone, responseMessage) {
    const state = conversationState.get(clientPhone);
    if (!state) {
        addLog('warning', `Resposta de cliente não encontrado: ${clientPhone}`);
        return { success: false, error: 'Cliente não encontrado' };
    }
    
    if (!state.waiting_for_response || !state.current_checkpoint) {
        addLog('info', `Cliente ${clientPhone} respondeu mas não estava aguardando resposta`);
        return { success: false, error: 'Não estava aguardando resposta' };
    }
    
    // Registra a resposta
    const response = {
        checkpoint_id: state.current_checkpoint,
        message: responseMessage,
        timestamp: new Date(),
        response_time: new Date() - state.last_activity
    };
    
    state.responses.push(response);
    state.checkpoint_history.push({
        checkpoint_id: state.current_checkpoint,
        passed_at: new Date(),
        response_message: responseMessage
    });
    
    // Atualiza contadores
    state.total_checkpoints_passed++;
    state.waiting_for_response = false;
    state.last_activity = new Date();
    
    const passedCheckpoint = state.current_checkpoint;
    state.current_checkpoint = null; // Limpa checkpoint atual
    
    // Atualiza estatísticas da instância
    updateInstanceStats(state.instance, 'response_received');
    
    conversationState.set(clientPhone, state);
    
    // Adiciona ao histórico global
    checkpointHistory.unshift({
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        client_phone: clientPhone,
        client_name: state.client_name,
        checkpoint_id: passedCheckpoint,
        response_message: responseMessage,
        instance: state.instance,
        timestamp: new Date(),
        brazil_time: getBrazilTime(),
        response_time_ms: response.response_time
    });
    
    addLog('checkpoint', `Cliente ${clientPhone} PASSOU checkpoint ${passedCheckpoint}: "${responseMessage.substring(0, 50)}..."`);
    
    return { 
        success: true, 
        checkpoint_passed: passedCheckpoint,
        client: clientPhone,
        response: responseMessage,
        total_passed: state.total_checkpoints_passed
    };
}

// ========== API ENDPOINTS PARA N8N ==========

// 1. INICIAR NOVA CONVERSA (Vem do redirecionador)
app.post('/api/start-conversation', async (req, res) => {
    try {
        const { client_phone, client_name, source = 'ads' } = req.body;
        
        if (!client_phone) {
            return res.status(400).json({ success: false, error: 'client_phone obrigatório' });
        }
        
        // Verifica se já existe conversa ativa
        if (conversationState.has(client_phone)) {
            const existing = conversationState.get(client_phone);
            addLog('info', `Cliente ${client_phone} já tem conversa ativa desde ${existing.created_at}`);
            return res.json({ 
                success: true, 
                status: 'existing',
                instance: existing.instance,
                current_checkpoint: existing.current_checkpoint
            });
        }
        
        // Seleciona melhor instância
        const instanceName = getBestInstance();
        updateInstanceStats(instanceName, 'new_lead');
        
        // Cria estado da conversa
        const state = createConversationState(client_phone, client_name || 'Cliente', instanceName);
        conversationState.set(client_phone, state);
        
        // Salva mapeamento instância
        clientInstanceMap.set(client_phone, {
            instance: instanceName,
            created_at: new Date()
        });
        
        addLog('conversation', `Nova conversa iniciada: ${client_phone} → ${instanceName}`);
        
        res.json({
            success: true,
            status: 'created',
            client_phone: client_phone,
            instance: instanceName,
            instance_apikey: getInstanceApiKey(instanceName), // Envia API Key junto
            conversation_id: `conv_${Date.now()}`
        });
        
    } catch (error) {
        addLog('error', `Erro ao iniciar conversa: ${error.message}`, { error: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. ATIVAR CHECKPOINT (N8N chama antes de enviar mensagem)
app.post('/api/activate-checkpoint', async (req, res) => {
    try {
        const { client_phone, checkpoint_id, message, step_data } = req.body;
        
        if (!client_phone || !checkpoint_id) {
            return res.status(400).json({ 
                success: false, 
                error: 'client_phone e checkpoint_id obrigatórios' 
            });
        }
        
        const result = activateCheckpoint(client_phone, checkpoint_id, { message, step_data });
        
        res.json(result);
        
    } catch (error) {
        addLog('error', `Erro ao ativar checkpoint: ${error.message}`, { error: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. VERIFICAR STATUS DO CHECKPOINT
app.get('/api/checkpoint-status/:client_phone', (req, res) => {
    try {
        const { client_phone } = req.params;
        const state = conversationState.get(client_phone);
        
        if (!state) {
            return res.status(404).json({ success: false, error: 'Cliente não encontrado' });
        }
        
        res.json({
            success: true,
            client_phone: client_phone,
            current_checkpoint: state.current_checkpoint,
            waiting_for_response: state.waiting_for_response,
            total_checkpoints_passed: state.total_checkpoints_passed,
            last_activity: state.last_activity,
            expires_at: state.expires_at,
            instance: state.instance,
            status: state.status
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== WEBHOOK EVOLUTION (RECEBE RESPOSTAS) ==========
app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            return res.status(200).json({ success: true, message: 'Dados inválidos' });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageContent = messageData.message?.conversation || '';
        const clientNumber = remoteJid.replace('@s.whatsapp.net', '');
        
        addLog('evolution_webhook', `Evolution: ${clientNumber} | FromMe: ${fromMe} | Conteúdo: "${messageContent.substring(0, 30)}..."`);
        
        // Só processa se NÃO for mensagem nossa
        if (!fromMe && messageContent.trim()) {
            // Tenta processar resposta do cliente
            const result = processClientResponse(clientNumber, messageContent);
            
            if (result.success) {
                // ENVIA PARA N8N que cliente passou pelo checkpoint
                const eventData = {
                    event_type: 'checkpoint_passed',
                    client_phone: clientNumber,
                    checkpoint_id: result.checkpoint_passed,
                    response_message: result.response,
                    total_checkpoints_passed: result.total_passed,
                    instance: state.instance,
                    instance_apikey: getInstanceApiKey(state.instance), // Adiciona API Key
                    timestamp: new Date().toISOString(),
                    brazil_time: getBrazilTime()
                };
                
                // Envia para N8N (async, não bloqueia resposta)
                sendToN8N(eventData, 'checkpoint_passed').catch(err => {
                    addLog('error', `Erro ao enviar checkpoint_passed para N8N: ${err.message}`);
                });
                
                addLog('success', `Cliente ${clientNumber} passou checkpoint ${result.checkpoint_passed} - Enviado para N8N`);
            }
        }
        
        res.status(200).json({ success: true });
        
    } catch (error) {
        addLog('error', `Erro no webhook Evolution: ${error.message}`, { error: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função para enviar dados para N8N
async function sendToN8N(eventData, eventType) {
    try {
        addLog('info', `Enviando para N8N: ${eventType}`);
        
        const response = await axios.post(N8N_WEBHOOK_URL, eventData, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Cerebro-Multi-Checkpoint/1.0'
            },
            timeout: 15000
        });
        
        addLog('webhook_sent', `Enviado para N8N: ${eventType} | Status: ${response.status}`);
        
        return { success: true, status: response.status, data: response.data };
        
    } catch (error) {
        const errorMessage = error.response ? 
            `HTTP ${error.response.status}: ${error.response.statusText}` : 
            error.message;
            
        addLog('error', `Erro N8N: ${eventType} | ${errorMessage}`);
        
        return { success: false, error: errorMessage };
    }
}

// ========== JOB DE LIMPEZA (TIMEOUT DOS CHECKPOINTS) ==========
function cleanupExpiredCheckpoints() {
    const now = new Date();
    let expiredCount = 0;
    
    for (const [phone, state] of conversationState.entries()) {
        if (now > state.expires_at && state.waiting_for_response) {
            // Checkpoint expirado
            state.status = 'expired';
            state.waiting_for_response = false;
            state.current_checkpoint = null;
            
            // Atualiza estatísticas da instância
            updateInstanceStats(state.instance, 'no_response');
            updateInstanceStats(state.instance, 'conversation_complete');
            
            addLog('timeout', `Checkpoint EXPIRADO para ${phone} (${state.client_name}) após 24h`);
            expiredCount++;
        }
        
        // Remove conversas muito antigas (48h)
        if (now - state.created_at > DATA_RETENTION_TIME) {
            conversationState.delete(phone);
            clientInstanceMap.delete(phone);
        }
    }
    
    // Limpa histórico antigo
    const cutoffTime = now.getTime() - DATA_RETENTION_TIME;
    checkpointHistory = checkpointHistory.filter(h => h.timestamp.getTime() > cutoffTime);
    systemLogs = systemLogs.filter(log => new Date(log.timestamp).getTime() > cutoffTime);
    
    if (expiredCount > 0) {
        addLog('cleanup', `Limpeza: ${expiredCount} checkpoints expirados removidos`);
    }
}

// Executa limpeza a cada 30 minutos
setInterval(cleanupExpiredCheckpoints, CLEANUP_INTERVAL);

// ========== DASHBOARD E ESTATÍSTICAS ==========

// Status principal com métricas de checkpoint
app.get('/status', (req, res) => {
    const conversationList = Array.from(conversationState.entries()).map(([phone, state]) => ({
        phone: phone,
        client_name: state.client_name,
        instance: state.instance,
        current_checkpoint: state.current_checkpoint,
        waiting_for_response: state.waiting_for_response,
        total_checkpoints_passed: state.total_checkpoints_passed,
        status: state.status,
        created_at: state.created_at,
        last_activity: state.last_activity,
        expires_at: state.expires_at
    }));
    
    // Estatísticas por instância
    const instanceStatsArray = Array.from(instanceStats.entries()).map(([name, stats]) => ({
        instance: name,
        ...stats,
        active_conversations: conversationList.filter(c => c.instance === name && c.status === 'active').length
    }));
    
    // Estatísticas de checkpoints
    const checkpointStats = {
        total_conversations_active: conversationList.filter(c => c.status === 'active').length,
        waiting_for_response: conversationList.filter(c => c.waiting_for_response).length,
        total_checkpoints_passed_today: checkpointHistory.filter(h => 
            new Date(h.timestamp).toDateString() === new Date().toDateString()
        ).length,
        avg_checkpoints_per_conversation: conversationList.length > 0 
            ? (conversationList.reduce((sum, c) => sum + c.total_checkpoints_passed, 0) / conversationList.length).toFixed(1)
            : 0
    };
    
    res.json({
        system_status: 'online',
        timestamp: new Date().toISOString(),
        brazil_time: getBrazilTime(),
        conversations: conversationList,
        instance_stats: instanceStatsArray,
        checkpoint_stats: checkpointStats,
        recent_checkpoints: checkpointHistory.slice(0, 50),
        system_logs: systemLogs.slice(-100),
        n8n_webhook_url: N8N_WEBHOOK_URL,
        config: {
            checkpoint_timeout: '24 horas',
            data_retention: '48 horas',
            cleanup_interval: '30 minutos'
        }
    });
});

// Histórico de checkpoints
app.get('/api/checkpoints', (req, res) => {
    const { limit = 100, instance, checkpoint_id } = req.query;
    
    let filtered = checkpointHistory;
    
    if (instance) {
        filtered = filtered.filter(h => h.instance === instance);
    }
    
    if (checkpoint_id) {
        filtered = filtered.filter(h => h.checkpoint_id === checkpoint_id);
    }
    
    res.json({
        total: filtered.length,
        checkpoints: filtered.slice(0, parseInt(limit)),
        brazil_time: getBrazilTime()
    });
});

// Dashboard HTML (versão expandida será criada depois)
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html><head><title>Cérebro Multi-Checkpoint</title></head>
    <body style="font-family: Arial; padding: 20px;">
        <h1>🧠 Sistema Multi-Checkpoint v1.0</h1>
        <p><strong>Status:</strong> Online</p>
        <p><strong>N8N Webhook:</strong> ${N8N_WEBHOOK_URL}</p>
        <p><strong>Conversas Ativas:</strong> <span id="conversations">0</span></p>
        <p><strong>Aguardando Resposta:</strong> <span id="waiting">0</span></p>
        
        <h2>APIs Disponíveis:</h2>
        <ul>
            <li>POST /api/start-conversation - Iniciar nova conversa</li>
            <li>POST /api/activate-checkpoint - Ativar checkpoint</li>
            <li>GET /api/checkpoint-status/:phone - Status do cliente</li>
            <li>GET /api/checkpoints - Histórico de checkpoints</li>
            <li>GET /status - Status completo do sistema</li>
        </ul>
        
        <script>
            async function updateStats() {
                try {
                    const response = await fetch('/status');
                    const data = await response.json();
                    document.getElementById('conversations').textContent = data.conversations.length;
                    document.getElementById('waiting').textContent = data.conversations.filter(c => c.waiting_for_response).length;
                } catch (error) {
                    console.error('Erro ao atualizar stats:', error);
                }
            }
            setInterval(updateStats, 5000);
            updateStats();
        </script>
    </body></html>
    `);
});

// Inicializa estatísticas das instâncias
initializeInstanceStats();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    addLog('info', `🧠 CÉREBRO MULTI-CHECKPOINT v1.0 iniciado na porta ${PORT}`);
    addLog('info', `📡 Webhook Evolution: http://localhost:${PORT}/webhook/evolution`);
    addLog('info', `🎯 API Start Conversation: http://localhost:${PORT}/api/start-conversation`);
    addLog('info', `✅ API Activate Checkpoint: http://localhost:${PORT}/api/activate-checkpoint`);
    addLog('info', `📊 API Checkpoint Status: http://localhost:${PORT}/api/checkpoint-status/:phone`);
    addLog('info', `📈 Dashboard: http://localhost:${PORT}`);
    addLog('info', `🎯 N8N Webhook: ${N8N_WEBHOOK_URL}`);
    
    console.log(`\n🧠 SISTEMA MULTI-CHECKPOINT ATIVO`);
    console.log(`=====================================`);
    console.log(`📡 APIs para N8N configuradas`);
    console.log(`✅ Sistema de rotação inteligente ativo`);
    console.log(`⏰ Timeout de checkpoints: 24 horas`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`=====================================\n`);
});
