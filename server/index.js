/**
 * index.js — Servidor Express
 * 
 * Responsabilidades:
 *   1. Servir arquivos estáticos (public/)
 *   2. POST /api/extract   → recebe .docx, retorna JSON estruturado
 *   3. POST /api/validate  → valida JSON modificado contra o original
 *   4. POST /api/reconstruct → reconstrói .docx a partir do JSON modificado
 * 
 * Armazena documentos em memória (Map) com TTL de 1 hora.
 */

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');

const { extractDocx } = require('./extractor');
const { validateModifiedJson } = require('./validator');
const { reconstructDocx } = require('./reconstructor');
const { callAI } = require('./ai-proxy');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext !== '.docx') {
            return cb(new Error('Apenas arquivos .docx são aceitos.'));
        }
        cb(null, true);
    }
});

// ─── Document Store (in-memory) ──────────────────────────

const documentStore = new Map();
const DOCUMENT_TTL = 60 * 60 * 1000; // 1 hora

// Limpa documentos expirados a cada 5 minutos
setInterval(() => {
    const now = Date.now();
    for (const [id, doc] of documentStore.entries()) {
        if (now - doc.createdAt > DOCUMENT_TTL) {
            documentStore.delete(id);
        }
    }
}, 5 * 60 * 1000);

// ─── Routes ──────────────────────────────────────────────

/**
 * POST /api/extract
 * Recebe um .docx via multipart, retorna JSON estruturado + documentId
 */
app.post('/api/extract', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        }

        const buffer = req.file.buffer;
        const fileName = req.file.originalname;

        const json = await extractDocx(buffer, fileName);

        // Gera ID único e armazena documento
        const documentId = crypto.randomUUID();
        documentStore.set(documentId, {
            buffer,
            originalJson: json,
            fileName,
            createdAt: Date.now()
        });

        res.json({
            documentId,
            data: json
        });
    } catch (err) {
        console.error('Erro na extração:', err);
        res.status(500).json({ error: err.message || 'Erro ao processar o arquivo.' });
    }
});

/**
 * POST /api/validate
 * Recebe { documentId, modifiedJson } e valida contra o original
 */
app.post('/api/validate', (req, res) => {
    try {
        const { documentId, modifiedJson } = req.body;

        if (!documentId || !modifiedJson) {
            return res.status(400).json({ error: 'documentId e modifiedJson são obrigatórios.' });
        }

        const doc = documentStore.get(documentId);
        if (!doc) {
            return res.status(404).json({
                error: 'Documento não encontrado. Faça upload novamente (documentos expiram após 1 hora).'
            });
        }

        const result = validateModifiedJson(modifiedJson, doc.originalJson);
        res.json(result);
    } catch (err) {
        console.error('Erro na validação:', err);
        res.status(500).json({ error: err.message || 'Erro ao validar o JSON.' });
    }
});

/**
 * POST /api/reconstruct
 * Recebe { documentId, modifiedJson }, valida e retorna novo .docx
 */
app.post('/api/reconstruct', async (req, res) => {
    try {
        const { documentId, modifiedJson } = req.body;

        if (!documentId || !modifiedJson) {
            return res.status(400).json({ error: 'documentId e modifiedJson são obrigatórios.' });
        }

        const doc = documentStore.get(documentId);
        if (!doc) {
            return res.status(404).json({
                error: 'Documento não encontrado. Faça upload novamente.'
            });
        }

        // Valida antes de reconstruir
        const validation = validateModifiedJson(modifiedJson, doc.originalJson);
        if (!validation.valid) {
            return res.status(400).json({
                error: 'JSON inválido. Corrija os erros antes de gerar o documento.',
                validationErrors: validation.errors
            });
        }

        // Reconstrói
        const newBuffer = await reconstructDocx(doc.buffer, modifiedJson, doc.originalJson);

        const newFileName = doc.fileName.replace(/\.docx$/i, '_modificado.docx');
        res.set({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(newFileName)}"`,
            'Content-Length': newBuffer.length
        });
        res.send(newBuffer);
    } catch (err) {
        console.error('Erro na reconstrução:', err);
        res.status(500).json({ error: err.message || 'Erro ao reconstruir o documento.' });
    }
});

// ─── POST /api/transform ─────────────────────────────────

app.post('/api/transform', async (req, res) => {
    try {
        const { documentId, userText, apiKey, provider } = req.body;

        if (!documentId || !userText || !apiKey) {
            return res.status(400).json({
                error: 'documentId, userText e apiKey são obrigatórios.'
            });
        }

        const doc = documentStore.get(documentId);
        if (!doc) {
            return res.status(404).json({
                error: 'Documento não encontrado. Faça upload novamente.'
            });
        }

        const aiProvider = provider || 'gemini';
        console.log(`[transform] Chamando ${aiProvider} para doc ${documentId}...`);
        const modifiedJson = await callAI(aiProvider, apiKey, doc.originalJson, userText);
        console.log(`[transform] Resposta recebida, ${modifiedJson.blocks?.length || 0} blocos.`);

        res.json({ success: true, modifiedJson });
    } catch (err) {
        console.error('[transform] Erro:', err.message);
        res.status(500).json({ error: err.message || 'Erro ao transformar com IA.' });
    }
});

// ─── Error Handler ───────────────────────────────────────

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'Arquivo muito grande. Limite: 50 MB.' });
        }
        return res.status(400).json({ error: err.message });
    }
    if (err.message) {
        return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Erro interno do servidor.' });
});

// ─── Start ───────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n  ╔══════════════════════════════════════════╗`);
    console.log(`  ║      DOC IA Editor — Servidor ativo      ║`);
    console.log(`  ║                                          ║`);
    console.log(`  ║   http://localhost:${PORT}                  ║`);
    console.log(`  ╚══════════════════════════════════════════╝\n`);
});
