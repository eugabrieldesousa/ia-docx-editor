/**
 * extractor.js
 *
 * Extrai estrutura de .docx para JSON intermediário.
 *
 * Tipos detectados:
 *   title      — título principal do documento
 *   heading    — seções numeradas (1., 2.1, 2.1.1) ou estilos Word
 *   paragraph  — texto normal
 *   list_item  — itens de lista (w:numPr ou bullet manual)
 *   table      — tabelas
 *
 * Formatação inline:
 *   **texto**  — negrito
 *   *texto*    — itálico
 *   ***texto***— negrito + itálico
 *
 * Regras:
 *   - Parágrafos vazios são removidos do JSON (mas contam no índice)
 *   - Parágrafos só com imagem são removidos
 *   - Imagens dentro de parágrafos com texto são ignoradas
 *   - Texto é trimado
 *   - IDs sequenciais mantidos para compatibilidade com reconstructor
 */

const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');

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

// ─── Plain Text (for pattern detection & emptiness check) ─

function getPlainText(node) {
    let text = '';
    if (!node || !node.childNodes) return text;
    for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeName === 'w:t') {
            text += child.textContent || '';
        } else if (child.nodeName === 'w:tab') {
            text += '\t';
        } else if (child.nodeName === 'w:br') {
            text += '\n';
        } else if (child.nodeType === 1 && child.nodeName !== 'w:pPr' && child.nodeName !== 'w:rPr') {
            text += getPlainText(child);
        }
    }
    return text;
}

// ─── Formatted Text (with **bold** / *italic*) ───────────

function hasBoolProp(rPr, propName) {
    if (!rPr) return false;
    const prop = getFirstChild(rPr, propName);
    if (!prop) return false;
    const val = prop.getAttribute('w:val');
    return val !== '0' && val !== 'false';
}

function collectFormattedSegments(node, segments) {
    if (!node || !node.childNodes) return;
    for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeName === 'w:r') {
            const rPr = getFirstChild(child, 'w:rPr');
            const bold = hasBoolProp(rPr, 'w:b');
            const italic = hasBoolProp(rPr, 'w:i');
            for (let j = 0; j < child.childNodes.length; j++) {
                const rc = child.childNodes[j];
                if (rc.nodeName === 'w:t') {
                    segments.push({ text: rc.textContent || '', bold, italic });
                } else if (rc.nodeName === 'w:tab') {
                    segments.push({ text: '\t', bold: false, italic: false });
                } else if (rc.nodeName === 'w:br') {
                    segments.push({ text: '\n', bold: false, italic: false });
                }
            }
        } else if (child.nodeName === 'w:hyperlink') {
            collectFormattedSegments(child, segments);
        }
    }
}

function mergeSegments(segments) {
    if (segments.length === 0) return [];
    const result = [{ ...segments[0] }];
    for (let i = 1; i < segments.length; i++) {
        const last = result[result.length - 1];
        if (last.bold === segments[i].bold && last.italic === segments[i].italic) {
            last.text += segments[i].text;
        } else {
            result.push({ ...segments[i] });
        }
    }
    return result;
}

function getFormattedText(pNode) {
    const segments = [];
    collectFormattedSegments(pNode, segments);
    const merged = mergeSegments(segments);

    let result = '';
    for (const seg of merged) {
        if (!seg.text) continue;
        if (seg.bold && seg.italic) result += `***${seg.text}***`;
        else if (seg.bold) result += `**${seg.text}**`;
        else if (seg.italic) result += `*${seg.text}*`;
        else result += seg.text;
    }
    return result;
}

// ─── Image Detection ─────────────────────────────────────

function hasImage(node) {
    const tags = ['w:drawing', 'w:pict', 'mc:AlternateContent'];
    for (const tag of tags) {
        if (node.getElementsByTagName(tag).length > 0) return true;
    }
    return false;
}

function isImageOnlyParagraph(pNode) {
    if (!hasImage(pNode)) return false;
    const text = getPlainText(pNode).trim();
    return text.length === 0;
}

// ─── Heading Detection ───────────────────────────────────

/**
 * Detecta heading por padrão numérico no texto.
 * "1. OBJETIVO" → level 1
 * "2.1 - Cabeçalho" → level 2
 * "2.1.1 Detalhe" → level 3
 * Retorna level ou null.
 */
function detectHeadingByPattern(text) {
    const trimmed = text.trim();
    const match = trimmed.match(/^(\d+(?:\.\d+)*)\s*[\.\-–—:)]\s*/);
    if (match) {
        return match[1].split('.').length;
    }
    const match2 = trimmed.match(/^(\d+)\s+[A-ZÁÀÂÃÉÈÊÍÏÓÔÕÖÚÇ]/);
    if (match2) return 1;
    return null;
}

// ─── List Detection ──────────────────────────────────────

function isListItem(pNode) {
    const pPr = getFirstChild(pNode, 'w:pPr');
    if (!pPr) return false;
    return getFirstChild(pPr, 'w:numPr') !== null;
}

function getListLevel(pNode) {
    const pPr = getFirstChild(pNode, 'w:pPr');
    if (!pPr) return 1;
    const numPr = getFirstChild(pPr, 'w:numPr');
    if (!numPr) return 1;
    const ilvl = getFirstChild(numPr, 'w:ilvl');
    if (!ilvl) return 1;
    return (parseInt(ilvl.getAttribute('w:val'), 10) || 0) + 1;
}

// ─── Heading Style Map ───────────────────────────────────

function buildHeadingStyleMap(stylesXml, parser) {
    const headingMap = {};
    if (!stylesXml) return headingMap;
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
        if (outlineLvls.length > 0) {
            const level = parseInt(outlineLvls[0].getAttribute('w:val'), 10);
            if (!isNaN(level)) headingMap[styleId] = level + 1;
        } else if (/^heading\s*\d+$/i.test(name)) {
            const m = name.match(/\d+/);
            if (m) headingMap[styleId] = parseInt(m[0], 10);
        }
    }
    return headingMap;
}

// ─── Block Classification ────────────────────────────────

function classifyParagraph(pNode, headingStyles) {
    const plainText = getPlainText(pNode).trim();       // para detecção de padrão
    const formattedText = getFormattedText(pNode).trim(); // para saída

    // 1. Word heading style
    const pPr = getFirstChild(pNode, 'w:pPr');
    if (pPr) {
        const pStyle = getFirstChild(pPr, 'w:pStyle');
        if (pStyle) {
            const styleVal = pStyle.getAttribute('w:val');
            if (styleVal && headingStyles[styleVal] !== undefined) {
                return { type: 'heading', level: headingStyles[styleVal], text: formattedText };
            }
        }
        const outlineLvl = getFirstChild(pPr, 'w:outlineLvl');
        if (outlineLvl) {
            const lvl = parseInt(outlineLvl.getAttribute('w:val'), 10);
            if (!isNaN(lvl)) return { type: 'heading', level: lvl + 1, text: formattedText };
        }
    }

    // 2. Heading by numbered text pattern (usa plainText sem markers)
    const patternLevel = detectHeadingByPattern(plainText);
    if (patternLevel !== null) {
        return { type: 'heading', level: patternLevel, text: formattedText };
    }

    // 3. List item by w:numPr
    if (isListItem(pNode)) {
        return { type: 'list_item', level: getListLevel(pNode), text: formattedText };
    }

    // 4. Regular paragraph
    return { type: 'paragraph', text: formattedText };
}

// ─── Table Extraction ────────────────────────────────────

function extractTable(tblNode, index) {
    const id = `block_${String(index).padStart(4, '0')}`;
    const rows = [];
    const trNodes = getDirectChildren(tblNode, 'w:tr');
    for (let rowIdx = 0; rowIdx < trNodes.length; rowIdx++) {
        const cells = [];
        const tcNodes = getDirectChildren(trNodes[rowIdx], 'w:tc');
        for (let cellIdx = 0; cellIdx < tcNodes.length; cellIdx++) {
            const cellText = getDirectChildren(tcNodes[cellIdx], 'w:p')
                .map(p => getFormattedText(p))
                .join('\n')
                .trim();
            cells.push({
                id: `cell_${String(index).padStart(4, '0')}_${rowIdx}_${cellIdx}`,
                text: cellText
            });
        }
        rows.push(cells);
    }
    return { id, type: 'table', rows };
}

// ─── Main ────────────────────────────────────────────────

async function extractDocx(buffer, fileName) {
    const zip = await JSZip.loadAsync(buffer);
    const documentXmlFile = zip.file('word/document.xml');
    if (!documentXmlFile) throw new Error('Arquivo .docx inválido: word/document.xml não encontrado.');
    const documentXml = await documentXmlFile.async('string');
    const stylesXmlFile = zip.file('word/styles.xml');
    const stylesXml = stylesXmlFile ? await stylesXmlFile.async('string') : null;

    const parser = new DOMParser();
    const doc = parser.parseFromString(documentXml, 'text/xml');
    const headingStyles = buildHeadingStyleMap(stylesXml, parser);

    const body = doc.getElementsByTagName('w:body')[0];
    if (!body) throw new Error('Documento inválido: w:body não encontrado.');

    const blocks = [];
    let blockIndex = 0;

    for (let i = 0; i < body.childNodes.length; i++) {
        const child = body.childNodes[i];
        if (child.nodeType !== 1) continue;

        if (child.nodeName === 'w:p') {
            const currentIdx = blockIndex;
            blockIndex++;

            // Pular parágrafos só com imagem
            if (isImageOnlyParagraph(child)) continue;

            const result = classifyParagraph(child, headingStyles);

            // Pular parágrafos vazios (plainText check)
            const plain = getPlainText(child).trim();
            if (!plain || plain.length === 0) continue;

            const block = {
                id: `block_${String(currentIdx).padStart(4, '0')}`,
                type: result.type,
                text: result.text
            };
            if (result.type === 'heading') block.level = result.level;
            if (result.type === 'list_item') block.level = result.level;
            blocks.push(block);

        } else if (child.nodeName === 'w:tbl') {
            blocks.push(extractTable(child, blockIndex));
            blockIndex++;
        }
    }

    // ── Detectar título ──
    for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type === 'heading' || blocks[i].type === 'table') break;
        if (blocks[i].type === 'paragraph') {
            blocks[i].type = 'title';
            break;
        }
    }

    return {
        metadata: {
            fileName: fileName || 'document.docx',
            extractedAt: new Date().toISOString(),
            blockCount: blocks.length,
            tableCount: blocks.filter(b => b.type === 'table').length
        },
        blocks
    };
}

module.exports = { extractDocx };
