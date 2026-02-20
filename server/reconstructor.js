/**
 * reconstructor.js
 * 
 * Reconstrói um .docx a partir do arquivo original + JSON modificado.
 * 
 * Suporta:
 *   - Blocos existentes: clona XML original, atualiza texto (com formatação markdown)
 *   - Blocos novos: cria XML a partir de templates extraídos do documento original
 *   - Blocos removidos: simplesmente não incluídos
 *   - Remoção de imagens: todas as imagens são removidas dos nós clonados
 *   - Formatação inline: **bold**, *italic*, ***bold+italic*** são convertidos para w:rPr
 */

const JSZip = require('jszip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

// ─── Helpers ──────────────────────────────────────────────

function getFirstChild(parent, tagName) {
    if (!parent) return null;
    for (let i = 0; i < parent.childNodes.length; i++) {
        if (parent.childNodes[i].nodeName === tagName) return parent.childNodes[i];
    }
    return null;
}

function getDirectChildren(parent, tagName) {
    const result = [];
    if (!parent) return result;
    for (let i = 0; i < parent.childNodes.length; i++) {
        if (parent.childNodes[i].nodeName === tagName) result.push(parent.childNodes[i]);
    }
    return result;
}

function removeChildrenByName(parent, tagName) {
    if (!parent) return;
    const toRemove = [];
    for (let i = 0; i < parent.childNodes.length; i++) {
        if (parent.childNodes[i].nodeName === tagName) toRemove.push(parent.childNodes[i]);
    }
    for (const el of toRemove) parent.removeChild(el);
}

// ─── Image Removal ───────────────────────────────────────

/**
 * Remove todas as imagens de um nó XML clonado.
 * Também remove runs que ficaram vazios após a remoção.
 */
function removeImages(node) {
    const imageTags = ['w:drawing', 'w:pict', 'mc:AlternateContent'];
    for (const tag of imageTags) {
        const elements = node.getElementsByTagName(tag);
        for (let i = elements.length - 1; i >= 0; i--) {
            const el = elements[i];
            if (el.parentNode) el.parentNode.removeChild(el);
        }
    }
    // Remover runs vazios (que tinham só imagem)
    if (node.nodeName === 'w:p' || node.nodeName === 'w:tc') {
        const runs = node.getElementsByTagName('w:r');
        for (let i = runs.length - 1; i >= 0; i--) {
            const run = runs[i];
            const hasContent = run.getElementsByTagName('w:t').length > 0 ||
                run.getElementsByTagName('w:br').length > 0 ||
                run.getElementsByTagName('w:tab').length > 0;
            if (!hasContent && run.parentNode) run.parentNode.removeChild(run);
        }
    }
}

// ─── Markdown Parsing ────────────────────────────────────

/**
 * Parse markdown markers: ***bold+italic***, **bold**, *italic*
 * Returns array of { text, bold, italic }
 */
function parseMarkdown(text) {
    if (!text) return [{ text: '', bold: false, italic: false }];

    const segments = [];
    const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*)/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            segments.push({ text: text.slice(lastIndex, match.index), bold: false, italic: false });
        }
        if (match[2] !== undefined) {
            segments.push({ text: match[2], bold: true, italic: true });
        } else if (match[3] !== undefined) {
            segments.push({ text: match[3], bold: true, italic: false });
        } else if (match[4] !== undefined) {
            segments.push({ text: match[4], bold: false, italic: true });
        }
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        segments.push({ text: text.slice(lastIndex), bold: false, italic: false });
    }

    return segments.length > 0 ? segments : [{ text, bold: false, italic: false }];
}

// ─── Heading Style Map ───────────────────────────────────

function buildHeadingStyleReverseMap(stylesXml, parser) {
    const map = {};
    if (!stylesXml) return map;
    const doc = parser.parseFromString(stylesXml, 'text/xml');
    const styles = doc.getElementsByTagName('w:style');
    for (let i = 0; i < styles.length; i++) {
        const style = styles[i];
        const type = style.getAttribute('w:type');
        const styleId = style.getAttribute('w:styleId');
        if (type !== 'paragraph' || !styleId) continue;
        const nameEls = style.getElementsByTagName('w:name');
        const name = nameEls.length > 0 ? (nameEls[0].getAttribute('w:val') || '') : '';
        const outlineLvls = style.getElementsByTagName('w:outlineLvl');
        let level = null;
        if (outlineLvls.length > 0) {
            level = parseInt(outlineLvls[0].getAttribute('w:val'), 10) + 1;
        } else if (/^heading\s*\d+$/i.test(name)) {
            level = parseInt(name.match(/\d+/)[0], 10);
        }
        if (level !== null && !isNaN(level)) map[level] = styleId;
    }
    return map;
}

// ─── Text Update (com suporte a markdown) ────────────────

/**
 * Atualiza o texto de um parágrafo, preservando fontes/cores do original
 * e convertendo marcadores markdown em formatação Word.
 */
function updateParagraphText(pNode, newText) {
    const doc = pNode.ownerDocument;

    // Capturar rPr template do primeiro run (preserva fonte, tamanho, cor)
    const existingRuns = getDirectChildren(pNode, 'w:r');
    let baseRPr = null;
    if (existingRuns.length > 0) {
        const rPr = getFirstChild(existingRuns[0], 'w:rPr');
        if (rPr) {
            baseRPr = rPr.cloneNode(true);
            // Remover bold/italic do template (serão adicionados por segmento)
            removeChildrenByName(baseRPr, 'w:b');
            removeChildrenByName(baseRPr, 'w:bCs');
            removeChildrenByName(baseRPr, 'w:i');
            removeChildrenByName(baseRPr, 'w:iCs');
        }
    }

    // Remover runs e hyperlinks existentes (manter pPr)
    const toRemove = [];
    for (let i = 0; i < pNode.childNodes.length; i++) {
        const name = pNode.childNodes[i].nodeName;
        if (name === 'w:r' || name === 'w:hyperlink' || name === 'w:bookmarkStart' || name === 'w:bookmarkEnd') {
            toRemove.push(pNode.childNodes[i]);
        }
    }
    for (const el of toRemove) pNode.removeChild(el);

    // Parse markdown e criar runs formatados
    const segments = parseMarkdown(newText);

    for (const seg of segments) {
        if (!seg.text) continue;

        const r = doc.createElementNS(W_NS, 'w:r');

        // Construir rPr: base (fonte/tamanho/cor) + bold/italic do segmento
        const rPr = baseRPr ? baseRPr.cloneNode(true) : doc.createElementNS(W_NS, 'w:rPr');
        if (seg.bold) {
            rPr.appendChild(doc.createElementNS(W_NS, 'w:b'));
            rPr.appendChild(doc.createElementNS(W_NS, 'w:bCs'));
        }
        if (seg.italic) {
            rPr.appendChild(doc.createElementNS(W_NS, 'w:i'));
            rPr.appendChild(doc.createElementNS(W_NS, 'w:iCs'));
        }
        // Só adicionar rPr se tiver filhos
        if (rPr.childNodes.length > 0) r.appendChild(rPr);

        const t = doc.createElementNS(W_NS, 'w:t');
        t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
        t.appendChild(doc.createTextNode(seg.text));
        r.appendChild(t);

        pNode.appendChild(r);
    }
}

function updateTableText(tblNode, modifiedRows) {
    const trNodes = getDirectChildren(tblNode, 'w:tr');
    for (let rowIdx = 0; rowIdx < trNodes.length && rowIdx < modifiedRows.length; rowIdx++) {
        const tr = trNodes[rowIdx];
        const modRow = modifiedRows[rowIdx];
        const tcNodes = getDirectChildren(tr, 'w:tc');
        for (let cellIdx = 0; cellIdx < tcNodes.length && cellIdx < modRow.length; cellIdx++) {
            const tc = tcNodes[cellIdx];
            updateCellText(tc, modRow[cellIdx].text);
        }
    }
}

function updateCellText(tcNode, newText) {
    const paragraphs = getDirectChildren(tcNode, 'w:p');
    if (paragraphs.length === 0) return;
    const segments = newText.split('\n');
    for (let i = 0; i < paragraphs.length; i++) {
        updateParagraphText(paragraphs[i], i < segments.length ? segments[i] : '');
    }
    if (segments.length > paragraphs.length) {
        const extra = segments.slice(paragraphs.length).join('\n');
        const lastP = paragraphs[paragraphs.length - 1];
        // Append extra text to last paragraph last run
        const runs = getDirectChildren(lastP, 'w:r');
        if (runs.length > 0) {
            const lastT = getFirstChild(runs[runs.length - 1], 'w:t');
            if (lastT) lastT.textContent = (lastT.textContent || '') + '\n' + extra;
        }
    }
}

// ─── New Block Creation ──────────────────────────────────

function createBasicParagraph(doc, text) {
    const p = doc.createElementNS(W_NS, 'w:p');
    if (text) {
        const segments = parseMarkdown(text);
        for (const seg of segments) {
            if (!seg.text) continue;
            const r = doc.createElementNS(W_NS, 'w:r');
            if (seg.bold || seg.italic) {
                const rPr = doc.createElementNS(W_NS, 'w:rPr');
                if (seg.bold) {
                    rPr.appendChild(doc.createElementNS(W_NS, 'w:b'));
                    rPr.appendChild(doc.createElementNS(W_NS, 'w:bCs'));
                }
                if (seg.italic) {
                    rPr.appendChild(doc.createElementNS(W_NS, 'w:i'));
                    rPr.appendChild(doc.createElementNS(W_NS, 'w:iCs'));
                }
                r.appendChild(rPr);
            }
            const t = doc.createElementNS(W_NS, 'w:t');
            t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
            t.appendChild(doc.createTextNode(seg.text));
            r.appendChild(t);
            p.appendChild(r);
        }
    }
    return p;
}

function createNewParagraph(doc, text, template) {
    if (template) {
        const node = template.cloneNode(true);
        removeImages(node);
        updateParagraphText(node, text);
        return node;
    }
    return createBasicParagraph(doc, text);
}

function createNewHeading(doc, text, level, headingTemplates, headingStyleMap) {
    if (headingTemplates[level]) {
        const node = headingTemplates[level].cloneNode(true);
        removeImages(node);
        updateParagraphText(node, text);
        return node;
    }
    const templateLevels = Object.keys(headingTemplates).map(Number);
    if (templateLevels.length > 0) {
        const closestLevel = templateLevels.reduce((a, b) =>
            Math.abs(b - level) < Math.abs(a - level) ? b : a
        );
        const node = headingTemplates[closestLevel].cloneNode(true);
        removeImages(node);
        const pPr = getFirstChild(node, 'w:pPr');
        if (pPr) {
            let pStyle = getFirstChild(pPr, 'w:pStyle');
            if (pStyle && headingStyleMap[level]) {
                pStyle.setAttribute('w:val', headingStyleMap[level]);
            } else if (!pStyle && headingStyleMap[level]) {
                pStyle = doc.createElementNS(W_NS, 'w:pStyle');
                pStyle.setAttribute('w:val', headingStyleMap[level]);
                pPr.insertBefore(pStyle, pPr.firstChild);
            }
        }
        updateParagraphText(node, text);
        return node;
    }
    const p = doc.createElementNS(W_NS, 'w:p');
    const pPr = doc.createElementNS(W_NS, 'w:pPr');
    const pStyle = doc.createElementNS(W_NS, 'w:pStyle');
    pStyle.setAttribute('w:val', headingStyleMap[level] || `Heading${level}`);
    pPr.appendChild(pStyle);
    p.appendChild(pPr);
    const segments = parseMarkdown(text);
    for (const seg of segments) {
        const r = doc.createElementNS(W_NS, 'w:r');
        if (seg.bold || seg.italic) {
            const rPr = doc.createElementNS(W_NS, 'w:rPr');
            if (seg.bold) rPr.appendChild(doc.createElementNS(W_NS, 'w:b'));
            if (seg.italic) rPr.appendChild(doc.createElementNS(W_NS, 'w:i'));
            r.appendChild(rPr);
        }
        const t = doc.createElementNS(W_NS, 'w:t');
        t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
        t.appendChild(doc.createTextNode(seg.text));
        r.appendChild(t);
        p.appendChild(r);
    }
    return p;
}

function createNewTable(doc, rows, template) {
    const tbl = doc.createElementNS(W_NS, 'w:tbl');
    if (template) {
        const tblPr = getFirstChild(template, 'w:tblPr');
        if (tblPr) tbl.appendChild(tblPr.cloneNode(true));
        const tblGrid = getFirstChild(template, 'w:tblGrid');
        if (tblGrid) tbl.appendChild(tblGrid.cloneNode(true));
    } else {
        const tblPr = doc.createElementNS(W_NS, 'w:tblPr');
        const tblW = doc.createElementNS(W_NS, 'w:tblW');
        tblW.setAttribute('w:w', '0');
        tblW.setAttribute('w:type', 'auto');
        tblPr.appendChild(tblW);
        tbl.appendChild(tblPr);
    }
    let templateRow = null, templateCell = null;
    if (template) {
        const trs = getDirectChildren(template, 'w:tr');
        if (trs.length > 0) {
            templateRow = trs[0];
            const tcs = getDirectChildren(templateRow, 'w:tc');
            if (tcs.length > 0) templateCell = tcs[0];
        }
    }
    for (const rowCells of rows) {
        const tr = doc.createElementNS(W_NS, 'w:tr');
        if (templateRow) {
            const trPr = getFirstChild(templateRow, 'w:trPr');
            if (trPr) tr.appendChild(trPr.cloneNode(true));
        }
        for (const cell of rowCells) {
            const tc = doc.createElementNS(W_NS, 'w:tc');
            if (templateCell) {
                const tcPr = getFirstChild(templateCell, 'w:tcPr');
                if (tcPr) tc.appendChild(tcPr.cloneNode(true));
            }
            tc.appendChild(createBasicParagraph(doc, cell.text));
            tr.appendChild(tc);
        }
        tbl.appendChild(tr);
    }
    return tbl;
}

function createNewBlock(doc, block, templates, headingStyleMap) {
    if (block.type === 'title') {
        return createNewParagraph(doc, block.text, templates.title || templates.paragraph);
    }
    if (block.type === 'paragraph') {
        return createNewParagraph(doc, block.text, templates.paragraph);
    }
    if (block.type === 'heading') {
        return createNewHeading(doc, block.text, block.level, templates.headings, headingStyleMap);
    }
    if (block.type === 'list_item') {
        return createNewParagraph(doc, block.text, templates.list_item || templates.paragraph);
    }
    if (block.type === 'table') {
        return createNewTable(doc, block.rows, templates.table);
    }
    return createBasicParagraph(doc, block.text || '');
}

// ─── Main Reconstruction ─────────────────────────────────

async function reconstructDocx(originalBuffer, modifiedJson, originalJson) {
    const zip = await JSZip.loadAsync(originalBuffer);
    const documentXmlFile = zip.file('word/document.xml');
    if (!documentXmlFile) throw new Error('Arquivo original inválido: word/document.xml não encontrado.');
    const documentXml = await documentXmlFile.async('string');
    const stylesXmlFile = zip.file('word/styles.xml');
    const stylesXml = stylesXmlFile ? await stylesXmlFile.async('string') : null;

    const parser = new DOMParser();
    const doc = parser.parseFromString(documentXml, 'text/xml');
    const headingStyleMap = buildHeadingStyleReverseMap(stylesXml, parser);

    const body = doc.getElementsByTagName('w:body')[0];
    if (!body) throw new Error('Documento original inválido: w:body não encontrado.');

    // ── Mapear blocos originais por ID ───────────────────
    const originalBlockNodes = new Map();
    const templates = { title: null, paragraph: null, headings: {}, list_item: null, table: null };
    const nonBlockNodes = [];

    let blockIndex = 0;
    for (let i = 0; i < body.childNodes.length; i++) {
        const child = body.childNodes[i];
        if (child.nodeType !== 1) continue;

        if (child.nodeName === 'w:p') {
            const id = `block_${String(blockIndex).padStart(4, '0')}`;
            originalBlockNodes.set(id, child);

            const origBlock = originalJson && originalJson.blocks.find(b => b.id === id);
            if (origBlock) {
                if (origBlock.type === 'title' && !templates.title) {
                    templates.title = child;
                } else if (origBlock.type === 'heading' && origBlock.level) {
                    if (!templates.headings[origBlock.level]) templates.headings[origBlock.level] = child;
                } else if (origBlock.type === 'list_item' && !templates.list_item) {
                    templates.list_item = child;
                } else if (origBlock.type === 'paragraph' && !templates.paragraph) {
                    templates.paragraph = child;
                }
            } else {
                if (!templates.paragraph) templates.paragraph = child;
            }
            blockIndex++;
        } else if (child.nodeName === 'w:tbl') {
            const id = `block_${String(blockIndex).padStart(4, '0')}`;
            originalBlockNodes.set(id, child);
            if (!templates.table) templates.table = child;
            blockIndex++;
        } else {
            nonBlockNodes.push(child);
        }
    }

    // ── Limpar body ──────────────────────────────────────
    while (body.firstChild) body.removeChild(body.firstChild);

    // ── Reconstruir body a partir do JSON modificado ─────
    for (const block of modifiedJson.blocks) {
        let node;

        if (originalBlockNodes.has(block.id)) {
            node = originalBlockNodes.get(block.id).cloneNode(true);
            removeImages(node); // ← SEMPRE remover imagens
            if (block.type === 'table') {
                updateTableText(node, block.rows);
            } else if (block.text !== undefined) {
                updateParagraphText(node, block.text);
            }
        } else {
            node = createNewBlock(doc, block, templates, headingStyleMap);
        }

        body.appendChild(node);
    }

    // ── Re-anexar sectPr etc. ────────────────────────────
    for (const el of nonBlockNodes) body.appendChild(el);

    // ── Serializar e retornar ────────────────────────────
    const serializer = new XMLSerializer();
    zip.file('word/document.xml', serializer.serializeToString(doc));

    return zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
    });
}

module.exports = { reconstructDocx };
