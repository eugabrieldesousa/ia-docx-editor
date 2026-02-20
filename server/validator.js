/**
 * validator.js
 * 
 * Valida o JSON modificado.
 * 
 * Regras RELAXADAS (blocos podem ser adicionados ou removidos):
 *   - JSON deve ter metadata e blocks
 *   - Cada bloco deve ter id, type válido, e campos corretos
 *   - IDs devem ser únicos
 *   - Blocos existentes (com ID igual ao original): tipo e level não podem mudar
 *   - Tabelas existentes: estrutura de linhas/colunas deve ser mantida
 *   - Novos blocos: apenas precisam ter estrutura válida
 */

/**
 * Retorna { valid: boolean, errors: string[] }
 */
function validateModifiedJson(modified, original) {
    const errors = [];

    // ── Estrutura raiz ───────────────────────────────────
    if (!modified || typeof modified !== 'object') {
        return { valid: false, errors: ['JSON deve ser um objeto.'] };
    }
    if (!modified.metadata || typeof modified.metadata !== 'object') {
        errors.push('Campo "metadata" ausente ou inválido.');
    }
    if (!Array.isArray(modified.blocks)) {
        return { valid: false, errors: ['Campo "blocks" deve ser um array.'] };
    }

    // ── Mapa do original para referência cruzada ─────────
    const originalBlockMap = new Map();
    if (original && Array.isArray(original.blocks)) {
        for (const block of original.blocks) {
            originalBlockMap.set(block.id, block);
        }
    }

    // ── Validação bloco a bloco ──────────────────────────
    const seenIds = new Set();

    for (let i = 0; i < modified.blocks.length; i++) {
        const block = modified.blocks[i];
        const prefix = `Bloco ${i}`;

        if (!block || typeof block !== 'object') {
            errors.push(`${prefix}: bloco ausente ou inválido.`);
            continue;
        }

        // ID obrigatório
        if (!block.id || typeof block.id !== 'string') {
            errors.push(`${prefix}: campo "id" ausente ou inválido.`);
            continue;
        }

        // IDs únicos
        if (seenIds.has(block.id)) {
            errors.push(`${prefix} (${block.id}): ID duplicado.`);
        }
        seenIds.add(block.id);

        // Tipo válido
        const validTypes = ['title', 'heading', 'paragraph', 'list_item', 'table'];
        if (!validTypes.includes(block.type)) {
            errors.push(`${prefix} (${block.id}): tipo "${block.type}" inválido. Use: heading, paragraph, table.`);
            continue;
        }

        // ── Referência cruzada com original ──────────────
        const origBlock = originalBlockMap.get(block.id);
        if (origBlock) {
            // Tipo não pode mudar para blocos existentes
            if (block.type !== origBlock.type) {
                errors.push(
                    `${prefix} (${block.id}): tipo alterado de "${origBlock.type}" para "${block.type}" — blocos existentes devem manter o tipo.`
                );
            }
            // Level de heading não pode mudar para blocos existentes
            if (origBlock.type === 'heading' && block.type === 'heading' && block.level !== origBlock.level) {
                errors.push(
                    `${prefix} (${block.id}): nível do heading alterado de ${origBlock.level} para ${block.level}.`
                );
            }
        }

        // ── Validação por tipo ───────────────────────────

        if (block.type === 'heading') {
            if (typeof block.level !== 'number' || block.level < 1) {
                errors.push(`${prefix} (${block.id}): heading deve ter "level" numérico >= 1.`);
            }
            if (typeof block.text !== 'string') {
                errors.push(`${prefix} (${block.id}): campo "text" deve ser uma string.`);
            }
        }

        if (block.type === 'title') {
            if (typeof block.text !== 'string') {
                errors.push(`${prefix} (${block.id}): campo "text" deve ser uma string.`);
            }
        }

        if (block.type === 'paragraph') {
            if (typeof block.text !== 'string') {
                errors.push(`${prefix} (${block.id}): campo "text" deve ser uma string.`);
            }
        }

        if (block.type === 'list_item') {
            if (typeof block.text !== 'string') {
                errors.push(`${prefix} (${block.id}): campo "text" deve ser uma string.`);
            }
            if (typeof block.level !== 'number' || block.level < 1) {
                errors.push(`${prefix} (${block.id}): list_item deve ter "level" numérico >= 1.`);
            }
        }

        if (block.type === 'table') {
            if (!Array.isArray(block.rows)) {
                errors.push(`${prefix} (${block.id}): campo "rows" deve ser um array.`);
                continue;
            }

            for (let r = 0; r < block.rows.length; r++) {
                const row = block.rows[r];
                if (!Array.isArray(row)) {
                    errors.push(`${prefix} (${block.id}), linha ${r}: deve ser um array de células.`);
                    continue;
                }
                for (let c = 0; c < row.length; c++) {
                    const cell = row[c];
                    if (!cell || typeof cell !== 'object') {
                        errors.push(`${prefix} (${block.id}), célula [${r}][${c}]: ausente ou inválida.`);
                        continue;
                    }
                    if (!cell.id || typeof cell.id !== 'string') {
                        errors.push(`${prefix} (${block.id}), célula [${r}][${c}]: campo "id" ausente.`);
                    }
                    if (seenIds.has(cell.id)) {
                        errors.push(`${prefix} (${block.id}), célula [${r}][${c}]: ID duplicado "${cell.id}".`);
                    }
                    if (cell.id) seenIds.add(cell.id);
                    if (typeof cell.text !== 'string') {
                        errors.push(`${prefix} (${block.id}), célula [${r}][${c}]: campo "text" deve ser string.`);
                    }
                }
            }

            // Se tabela existe no original, validar estrutura (linhas × colunas)
            if (origBlock && origBlock.type === 'table') {
                if (block.rows.length !== origBlock.rows.length) {
                    errors.push(
                        `${prefix} (${block.id}): número de linhas alterado de ${origBlock.rows.length} para ${block.rows.length}.`
                    );
                } else {
                    for (let r = 0; r < origBlock.rows.length; r++) {
                        if (block.rows[r] && origBlock.rows[r] && block.rows[r].length !== origBlock.rows[r].length) {
                            errors.push(
                                `${prefix} (${block.id}), linha ${r}: número de células alterado de ${origBlock.rows[r].length} para ${block.rows[r].length}.`
                            );
                        }
                    }
                }
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

module.exports = { validateModifiedJson };
