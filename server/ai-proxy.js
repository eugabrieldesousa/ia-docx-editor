/**
 * ai-proxy.js
 * 
 * Proxy para chamadas à APIs de IA.
 * Suporta:
 *   - OpenRouter (grátis, DeepSeek e outros modelos)
 *   - OpenAI / ChatGPT (pago, gpt-4o-mini)
 */

const https = require('https');

// ─── HTTP Client ─────────────────────────────────────────

function httpsPost(url, headers, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const data = JSON.stringify(body);

        const options = {
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                ...headers
            }
        };

        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(responseData) });
                } catch (e) {
                    console.error('[ai-proxy] Resposta não é JSON:', responseData.substring(0, 300));
                    reject(new Error('Resposta inválida da API'));
                }
            });
        });

        req.on('error', (err) => {
            reject(new Error(`Erro de conexão: ${err.message}`));
        });
        req.setTimeout(120000, () => {
            req.destroy();
            reject(new Error('Timeout: a IA demorou mais de 2 minutos para responder.'));
        });
        req.write(data);
        req.end();
    });
}

// ─── Prompt Builder ──────────────────────────────────────

function buildSystemPrompt() {
    return `Você é um formatador de documentos Word (.docx).

Você recebe um JSON extraído de um documento original como referência de ESTRUTURA e ESTILO,
e um texto com o novo conteúdo. Gere um JSON no MESMO FORMATO com o novo conteúdo,
seguindo rigorosamente o padrão de estilização do documento original.

═══ TIPOS DE BLOCOS ═══

"title"     → Título principal do documento
"table"     → Tabela com linhas e células
"heading"   → Seções numeradas (precisa de "level"):
              level 1: "1. OBJETIVO", "2. ATIVIDADES"
              level 2: "2.1 - Subseção"
              level 3: "2.1.1 - Detalhe"
"paragraph" → Texto normal
"list_item" → Itens de lista (precisa de "level": 1, 2...)

═══ FORMATAÇÃO INLINE (dentro do "text") ═══

Use markdown para formatação dentro do texto:
  **texto em negrito**
  *texto em itálico*
  ***negrito e itálico***

Use \\n para quebra de linha e \\t para tabulação.

═══ REGRAS OBRIGATÓRIAS ═══

- SIGA EXATAMENTE o padrão de estilo do JSON original (mesma ordem de tipos, mesma formatação)
- Mantenha a mesma estrutura base (título, tabela de metadados se houver, seções numeradas)
- Para blocos que permanecem iguais ao original, mantenha o ID original
- Para novos blocos, use IDs sequenciais: "new_001", "new_002", etc.
- NÃO incluir blocos vazios (text vazio)
- NÃO incluir imagens
- Atualizar blockCount e tableCount na metadata
- Cada bloco DEVE ter: id, type, text (e level para heading/list_item, rows para table)
- Cada célula de tabela DEVE ter: id e text

Responda APENAS com JSON puro, sem explicações, sem blocos de código markdown.`;
}

function buildUserPrompt(originalJson, userText) {
    return `═══ JSON DO DOCUMENTO ORIGINAL (referência de estilo) ═══

${JSON.stringify(originalJson, null, 2)}

═══ NOVO CONTEÚDO DO USUÁRIO ═══

${userText}

═══ INSTRUÇÃO ═══

Gere o JSON completo com o novo conteúdo acima, seguindo EXATAMENTE o padrão
de estilo e estrutura do documento original. Responda APENAS com JSON puro.`;
}

// ─── Clean AI Response ───────────────────────────────────

function parseJsonResponse(text) {
    let clean = text.trim();
    // Remover marcadores de code block
    if (clean.startsWith('```json')) clean = clean.slice(7);
    else if (clean.startsWith('```')) clean = clean.slice(3);
    if (clean.endsWith('```')) clean = clean.slice(0, -3);
    clean = clean.trim();

    try {
        return JSON.parse(clean);
    } catch (e) {
        console.error('[ai-proxy] Falha ao parsear JSON. Primeiros 500 chars:', clean.substring(0, 500));
        throw new Error('A IA não retornou JSON válido. Tente novamente ou reformule o texto.');
    }
}

// ─── OpenAI-Compatible Call (funciona com OpenRouter e OpenAI) ───

async function callOpenAICompatible(config, apiKey, originalJson, userText) {
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(originalJson, userText);

    const body = {
        model: config.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.1
    };

    // Adicionar max_tokens se definido
    if (config.maxTokens) {
        body.max_tokens = config.maxTokens;
    }

    // Desabilitar raciocínio para evitar que modelos gastem tokens "pensando"
    // sem gerar conteúdo real
    if (config.noReasoning) {
        body.reasoning = { effort: 'none' };
    }

    const headers = {
        'Authorization': `Bearer ${apiKey}`
    };

    // Headers extras (ex: OpenRouter pede HTTP-Referer)
    if (config.extraHeaders) {
        Object.assign(headers, config.extraHeaders);
    }

    console.log(`[${config.name}] Modelo: ${config.model}, prompt ~ ${userPrompt.length} chars`);
    const response = await httpsPost(config.endpoint, headers, body);

    const modelUsed = response.data?.model || config.model;
    console.log(`[${config.name}] Status: ${response.status}, modelo usado: ${modelUsed}`);

    if (response.status !== 200) {
        const errMsg = response.data?.error?.message || JSON.stringify(response.data?.error) || `Status ${response.status}`;
        console.error(`[${config.name}] ERRO ${response.status}:`, errMsg);

        if (response.status === 401) {
            throw new Error(`API Key inválida. Verifique sua chave em ${config.keyUrl}`);
        }
        if (response.status === 402) {
            throw new Error(`Sem créditos. Verifique seu saldo em ${config.keyUrl}`);
        }
        if (response.status === 429) {
            throw new Error(`Limite de requisições atingido. Aguarde um momento e tente novamente. Detalhe: ${errMsg}`);
        }
        throw new Error(`Erro ${config.name} (${response.status}): ${errMsg}`);
    }

    // Extrair conteúdo - tentar content primeiro, depois reasoning como fallback
    let text = response.data?.choices?.[0]?.message?.content;

    if (!text || text.trim().length < 10) {
        // Verificar se o modelo gastou tudo em reasoning
        const reasoning = response.data?.usage?.completion_tokens_details?.reasoning_tokens || 0;
        const total = response.data?.usage?.completion_tokens || 0;

        if (reasoning > 0 && reasoning >= total * 0.9) {
            console.error(`[${config.name}] Modelo ${modelUsed} gastou ${reasoning}/${total} tokens em raciocínio. Conteúdo vazio.`);
            throw new Error(`EMPTY_RESPONSE: Modelo ${modelUsed} gastou todos os tokens em raciocínio.`);
        }

        console.error(`[${config.name}] Resposta sem conteúdo do modelo ${modelUsed}`);
        throw new Error(`EMPTY_RESPONSE: ${config.name} retornou resposta vazia.`);
    }

    console.log(`[${config.name}] OK! Modelo: ${modelUsed}, resposta: ${text.length} chars`);
    return parseJsonResponse(text);
}

// ─── Provider Configs ────────────────────────────────────

const providers = {
    openrouter: {
        name: 'OpenRouter',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        model: 'deepseek/deepseek-chat',
        fallbackModel: 'openrouter/free',
        noReasoning: true,
        keyUrl: 'openrouter.ai/keys',
        extraHeaders: {
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'DOC IA Editor'
        }
    },
    openai: {
        name: 'OpenAI',
        endpoint: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4o-mini',
        maxTokens: 16384,
        keyUrl: 'platform.openai.com/api-keys'
    }
};

// ─── Unified Call ────────────────────────────────────────

async function callAI(provider, apiKey, originalJson, userText) {
    const config = providers[provider];
    if (!config) {
        throw new Error(`Provedor "${provider}" não suportado. Use: ${Object.keys(providers).join(', ')}`);
    }

    try {
        return await callOpenAICompatible(config, apiKey, originalJson, userText);
    } catch (err) {
        // Se modelo indisponível OU resposta vazia, tentar fallback
        const shouldFallback = config.fallbackModel && (
            err.message.includes('404') ||
            err.message.includes('not found') ||
            err.message.includes('No endpoints') ||
            err.message.includes('EMPTY_RESPONSE')
        );

        if (shouldFallback) {
            console.log(`[ai-proxy] Erro com ${config.model}, tentando fallback: ${config.fallbackModel}`);
            const fallbackConfig = {
                ...config,
                model: config.fallbackModel,
                name: config.name + ' (fallback)',
                fallbackModel: null // não fazer fallback do fallback
            };
            return await callOpenAICompatible(fallbackConfig, apiKey, originalJson, userText);
        }

        // Limpar mensagem de erro para o usuário
        throw new Error(err.message.replace('EMPTY_RESPONSE: ', ''));
    }
}

module.exports = { callAI };
