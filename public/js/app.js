/**
 * app.js — Client-side application logic
 *
 * Responsável por:
 *   - Upload de .docx (drag & drop + file input)
 *   - Transformação via IA (Google Gemini)
 *   - Exibição do JSON extraído
 *   - Copiar/colar JSON
 *   - Validação via API
 *   - Download do .docx reconstruído
 *   - Gerenciamento de estado e UI
 */

// ─── State ───────────────────────────────────────────────

const state = {
    documentId: null,
    originalJson: null,
    validated: false
};

// ─── DOM Elements ────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const uploadArea = $('#upload-area');
const fileInput = $('#file-input');
const fileInfoEl = $('#upload-file-info');
const fileNameDisplay = $('#file-name-display');
const sectionJson = $('#section-json');
const sectionActions = $('#section-actions');
const jsonOriginal = $('#json-original');
const jsonModified = $('#json-modified');
const jsonStats = $('#json-stats');
const btnCopy = $('#btn-copy');
const btnPaste = $('#btn-paste');
const btnValidate = $('#btn-validate');
const btnGenerate = $('#btn-generate');
const btnReset = $('#btn-reset');
const btnHelp = $('#btn-help');
const btnCloseHelp = $('#btn-close-help');
const btnCopyPrompt = $('#btn-copy-prompt');
const helpModal = $('#help-modal');
const messagesContainer = $('#messages-container');
const loadingOverlay = $('#loading-overlay');
const loadingText = $('#loading-text');

// AI elements
const apiKeyInput = $('#api-key-input');
const btnToggleKey = $('#btn-toggle-key');
const userText = $('#user-text');
const btnTransform = $('#btn-transform');
const manualSection = $('#manual-section');
const aiProvider = $('#ai-provider');
const apiKeyLink = $('#api-key-link');

// ─── Provider & API Key Management ───────────────────────────

const providerConfig = {
    openrouter: {
        placeholder: 'API Key do OpenRouter (sk-or-...)',
        linkText: 'Obter chave grátis →',
        linkUrl: 'https://openrouter.ai/keys',
        storageKey: 'openrouter_api_key'
    },
    openai: {
        placeholder: 'API Key da OpenAI (sk-...)',
        linkText: 'Obter chave →',
        linkUrl: 'https://platform.openai.com/api-keys',
        storageKey: 'openai_api_key'
    }
};

// Load saved provider
const savedProvider = localStorage.getItem('ai_provider') || 'openrouter';
aiProvider.value = savedProvider;
updateProviderUI();

function updateProviderUI() {
    const config = providerConfig[aiProvider.value];
    apiKeyInput.placeholder = config.placeholder;
    apiKeyLink.textContent = config.linkText;
    apiKeyLink.href = config.linkUrl;
    // Load saved key for this provider
    const savedKey = localStorage.getItem(config.storageKey);
    apiKeyInput.value = savedKey || '';
    updateTransformButton();
}

aiProvider.addEventListener('change', () => {
    localStorage.setItem('ai_provider', aiProvider.value);
    updateProviderUI();
});

apiKeyInput.addEventListener('input', () => {
    const config = providerConfig[aiProvider.value];
    const key = apiKeyInput.value.trim();
    if (key) localStorage.setItem(config.storageKey, key);
    else localStorage.removeItem(config.storageKey);
    updateTransformButton();
});

btnToggleKey.addEventListener('click', () => {
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

userText.addEventListener('input', updateTransformButton);

function updateTransformButton() {
    const hasKey = apiKeyInput.value.trim().length > 0;
    const hasText = userText.value.trim().length > 0;
    const hasDoc = state.documentId !== null;
    btnTransform.disabled = !(hasKey && hasText && hasDoc);
}

// ─── AI Transform ────────────────────────────────────────

btnTransform.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    const text = userText.value.trim();

    if (!apiKey) {
        showMessage('error', 'API Key necessária', 'Insira sua chave da API do Google Gemini. <a href="https://aistudio.google.com/apikey" target="_blank">Obter grátis →</a>');
        return;
    }
    if (!text) {
        showMessage('error', 'Texto vazio', 'Escreva a documentação que deseja formatar.');
        return;
    }
    if (!state.documentId) {
        showMessage('error', 'Documento não carregado', 'Faça upload de um .docx primeiro.');
        return;
    }

    clearMessages();
    btnTransform.classList.add('loading');
    btnTransform.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        Processando...
    `;
    showLoading('Enviando para IA... isso pode levar até 1 minuto.');

    try {
        const res = await fetch('/api/transform', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                documentId: state.documentId,
                userText: text,
                apiKey: apiKey,
                provider: aiProvider.value
            })
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || 'Erro ao transformar com IA.');
        }

        // Preencher JSON Modificado
        const prettyJson = JSON.stringify(data.modifiedJson, null, 2);
        jsonModified.value = prettyJson;

        // Abrir seção manual para mostrar o resultado
        manualSection.open = true;

        showMessage('success', 'Transformação concluída!',
            `A IA gerou ${data.modifiedJson.blocks?.length || 0} blocos. O JSON foi preenchido automaticamente. Clique em "Validar" para verificar.`);

        // Auto-validar
        state.validated = false;
        btnGenerate.disabled = true;

    } catch (err) {
        showMessage('error', 'Erro na transformação', err.message);
    } finally {
        hideLoading();
        btnTransform.classList.remove('loading');
        btnTransform.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            Transformar com IA
        `;
    }
});

// ─── Upload ──────────────────────────────────────────────

uploadArea.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFile(e.target.files[0]);
    }
});

// Drag & Drop
uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('drag-over');
});

uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('drag-over');
});

uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
        handleFile(e.dataTransfer.files[0]);
    }
});

async function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.docx')) {
        showMessage('error', 'Formato inválido', 'Apenas arquivos .docx são aceitos.');
        return;
    }

    showLoading('Extraindo estrutura do documento...');
    clearMessages();

    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch('/api/extract', {
            method: 'POST',
            body: formData
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || 'Erro ao extrair documento.');
        }

        // Update state
        state.documentId = data.documentId;
        state.originalJson = data.data;
        state.validated = false;

        // Update UI
        uploadArea.classList.add('has-file');
        fileInfoEl.hidden = false;
        fileNameDisplay.textContent = file.name;

        const prettyJson = JSON.stringify(data.data, null, 2);
        jsonOriginal.value = prettyJson;
        jsonModified.value = '';

        // Show stats
        const meta = data.data.metadata;
        jsonStats.textContent = `${meta.blockCount} blocos · ${meta.tableCount} tabelas · extraído em ${new Date(meta.extractedAt).toLocaleTimeString('pt-BR')}`;
        jsonStats.classList.add('visible');

        // Show sections
        sectionJson.hidden = false;
        sectionActions.hidden = false;
        btnGenerate.disabled = true;
        updateTransformButton();

        showMessage('success', 'Documento extraído com sucesso!',
            `${meta.blockCount} blocos encontrados (${meta.tableCount} tabelas). Escreva a documentação e clique em "Transformar com IA".`);

    } catch (err) {
        showMessage('error', 'Erro na extração', err.message);
    } finally {
        hideLoading();
    }
}

// ─── Copy / Paste ────────────────────────────────────────

btnCopy.addEventListener('click', async () => {
    if (!jsonOriginal.value) return;
    try {
        await navigator.clipboard.writeText(jsonOriginal.value);
        showToast('JSON copiado para a área de transferência!');
    } catch {
        // Fallback
        jsonOriginal.select();
        document.execCommand('copy');
        showToast('JSON copiado!');
    }
});

btnPaste.addEventListener('click', async () => {
    try {
        const text = await navigator.clipboard.readText();
        jsonModified.value = text;
        jsonModified.dispatchEvent(new Event('input'));
        showToast('JSON colado da área de transferência!');
    } catch {
        jsonModified.focus();
        showToast('Use Ctrl+V para colar', 'warning');
    }
});

btnCopyPrompt.addEventListener('click', async () => {
    const promptEl = $('#ai-prompt');
    try {
        await navigator.clipboard.writeText(promptEl.textContent);
        showToast('Prompt copiado!');
    } catch {
        // Fallback - select text
        const range = document.createRange();
        range.selectNodeContents(promptEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('copy');
        showToast('Prompt copiado!');
    }
});

// Reset validated state when modified JSON changes
jsonModified.addEventListener('input', () => {
    state.validated = false;
    btnGenerate.disabled = true;
});

// ─── Validate ────────────────────────────────────────────

btnValidate.addEventListener('click', async () => {
    clearMessages();

    const modifiedText = jsonModified.value.trim();
    if (!modifiedText) {
        showMessage('error', 'JSON vazio', 'Cole o JSON modificado pela IA antes de validar.');
        return;
    }

    if (!state.documentId) {
        showMessage('error', 'Documento não carregado', 'Faça upload de um .docx primeiro.');
        return;
    }

    // Parse JSON
    let modifiedJson;
    try {
        modifiedJson = JSON.parse(modifiedText);
    } catch (e) {
        showMessage('error', 'JSON inválido',
            `O texto não é um JSON válido. Verifique a sintaxe.<br><code>${escapeHtml(e.message)}</code>`);
        return;
    }

    showLoading('Validando estrutura...');

    try {
        const res = await fetch('/api/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                documentId: state.documentId,
                modifiedJson
            })
        });

        const result = await res.json();

        if (!res.ok) {
            throw new Error(result.error || 'Erro na validação.');
        }

        if (result.valid) {
            state.validated = true;
            btnGenerate.disabled = false;
            showMessage('success', 'Estrutura válida!',
                'A estrutura do JSON modificado é compatível com a original. Você pode gerar o novo documento.');
        } else {
            state.validated = false;
            btnGenerate.disabled = true;
            const errorList = result.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('');
            showMessage('error', `Validação falhou (${result.errors.length} erro${result.errors.length > 1 ? 's' : ''})`,
                `<ul>${errorList}</ul>`);
        }
    } catch (err) {
        showMessage('error', 'Erro na validação', err.message);
    } finally {
        hideLoading();
    }
});

// ─── Generate DOCX ───────────────────────────────────────

btnGenerate.addEventListener('click', async () => {
    if (!state.validated || !state.documentId) return;

    clearMessages();

    let modifiedJson;
    try {
        modifiedJson = JSON.parse(jsonModified.value.trim());
    } catch {
        showMessage('error', 'JSON inválido', 'Valide o JSON novamente.');
        return;
    }

    showLoading('Gerando novo documento...');

    try {
        const res = await fetch('/api/reconstruct', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                documentId: state.documentId,
                modifiedJson
            })
        });

        if (!res.ok) {
            const errData = await res.json();
            if (errData.validationErrors) {
                const errorList = errData.validationErrors.map(e => `<li>${escapeHtml(e)}</li>`).join('');
                showMessage('error', 'Validação falhou ao gerar', `<ul>${errorList}</ul>`);
            } else {
                throw new Error(errData.error || 'Erro ao gerar documento.');
            }
            return;
        }

        // Download do arquivo
        const blob = await res.blob();
        const contentDisposition = res.headers.get('Content-Disposition') || '';
        let fileName = 'documento_modificado.docx';
        const match = contentDisposition.match(/filename="?([^"]+)"?/);
        if (match) {
            fileName = decodeURIComponent(match[1]);
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showMessage('success', 'Documento gerado com sucesso!',
            `O arquivo <strong>${escapeHtml(fileName)}</strong> foi baixado. A estrutura original foi preservada com o texto modificado.`);

    } catch (err) {
        showMessage('error', 'Erro na geração', err.message);
    } finally {
        hideLoading();
    }
});

// ─── Reset ───────────────────────────────────────────────

btnReset.addEventListener('click', () => {
    state.documentId = null;
    state.originalJson = null;
    state.validated = false;

    fileInput.value = '';
    uploadArea.classList.remove('has-file');
    fileInfoEl.hidden = true;
    fileNameDisplay.textContent = '';

    jsonOriginal.value = '';
    jsonModified.value = '';
    jsonStats.classList.remove('visible');
    jsonStats.textContent = '';

    sectionJson.hidden = true;
    sectionActions.hidden = true;
    btnGenerate.disabled = true;

    userText.value = '';
    updateTransformButton();

    clearMessages();

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ─── Help Modal ──────────────────────────────────────────

btnHelp.addEventListener('click', () => {
    helpModal.hidden = false;
    document.body.style.overflow = 'hidden';
});

function closeHelp() {
    helpModal.hidden = true;
    document.body.style.overflow = '';
}

btnCloseHelp.addEventListener('click', closeHelp);

helpModal.querySelector('.modal-backdrop').addEventListener('click', closeHelp);

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !helpModal.hidden) {
        closeHelp();
    }
});

// ─── Messages ────────────────────────────────────────────

function showMessage(type, title, details) {
    messagesContainer.hidden = false;

    const icons = {
        error: '<svg class="message-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        success: '<svg class="message-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        warning: '<svg class="message-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
    };

    const msg = document.createElement('div');
    msg.className = `message message-${type}`;
    msg.innerHTML = `
        ${icons[type] || ''}
        <div class="message-body">
            <div class="message-title">${title}</div>
            ${details ? `<div class="message-details">${details}</div>` : ''}
        </div>
    `;
    messagesContainer.appendChild(msg);

    // Scroll to message
    msg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearMessages() {
    messagesContainer.innerHTML = '';
    messagesContainer.hidden = true;
}

// ─── Toast Notifications ─────────────────────────────────

function showToast(text) {
    const toast = document.createElement('div');
    toast.className = 'copy-feedback';
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => {
        if (toast.parentNode) toast.remove();
    }, 2200);
}

// ─── Loading ─────────────────────────────────────────────

function showLoading(text) {
    loadingText.textContent = text || 'Processando...';
    loadingOverlay.hidden = false;
}

function hideLoading() {
    loadingOverlay.hidden = true;
}

// ─── Utilities ───────────────────────────────────────────

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
