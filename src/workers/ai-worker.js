import { dbPromise } from "../db.js";

self.onmessage = async (e) => {
    const { type, data, aiSettings } = e.data;

    try {
        switch (type) {
            case 'analyze-categories':
                await analyzeCategories(data.items, aiSettings);
                break;
            case 'apply-merges':
                await applyMerges(data.merges);
                break;
            case 'categorize-removed':
                await categorizeRemoved(data.items, data.removedCats, data.validCats, data.usersProposedNew, data.merged, aiSettings);
                break;
            case 'audit-category':
                await auditCategory(data.categoryName, data.items, data.validCats, aiSettings);
                break;
            case 'analyze-parents':
                await analyzeParents(data.items, aiSettings);
                break;
            default:
                throw new Error(`Unknown message type: ${type}`);
        }
    } catch (error) {
        self.postMessage({ type: 'error', error: error.message });
    }
};

async function analyzeCategories(allItems, aiSettings) {
    self.postMessage({ type: 'progress', message: "Analyzing Categories..." });

    if (!aiSettings.url) throw new Error("Configure AI Settings first.");

    const categoryMap = {};
    allItems.forEach(item => {
        const cat = item.category || "Uncategorized";
        if (!categoryMap[cat]) categoryMap[cat] = [];
        if (categoryMap[cat].length < 5) categoryMap[cat].push(item.name);
    });

    const promptData = Object.entries(categoryMap).map(([cat, samples]) => ({
        category: cat,
        samples: samples
    }));

    const prompt = `
    You are an expert inventory manager. Analyze these categories.
    Task:
    1. Identify categories to REMOVE (redundant, vague, spelling errors).
    2. Identify categories to MERGE (e.g. "Bev" -> "Beverages").
    3. Identify PROPOSED NEW categories if beneficial.

    Data: ${JSON.stringify(promptData)}

    Return JSON only:
    {
        "removed": ["cat1", "cat2"],
        "merged": [{"old": "oldName", "new": "newName"}],
        "users_proposed_new": ["High Margin", "Seasonal"]
    }
    `;

    const result = await callLLM(aiSettings, prompt);
    self.postMessage({ type: 'success', result });
}

async function applyMerges(merges) {
    self.postMessage({ type: 'progress', message: "Merging Categories..." });
    const db = await dbPromise;

    for (const merge of merges) {
        await db.items.where('category').equals(merge.old).modify({ category: merge.new });
    }

    self.postMessage({ type: 'success' });
}

async function categorizeRemoved(itemsToProcess, removedCats, validCats, usersProposedNew, merged, aiSettings) {
    if (itemsToProcess.length === 0) {
        self.postMessage({ type: 'success', count: 0 });
        return;
    }

    const BATCH_SIZE = 100;
    const db = await dbPromise;
    let processedCount = 0;

    // Build full valid list locally if needed, but passed in data is better
    // logic copied from original file but adapted to worker context
    // The validCats passed in should already be filtered/prepared by the main thread or we do it here.
    // The main thread passed 'validCats' which are existing ones. We need to add proposed/merged.

    const allValid = [...validCats];
    if (usersProposedNew) allValid.push(...usersProposedNew);
    if (merged) {
        merged.forEach(m => {
            if (!allValid.includes(m.new)) allValid.push(m.new);
        });
    }

    // Filter out removed ones just in case
    const finalValid = allValid.filter(c => !removedCats.includes(c));

    for (let i = 0; i < itemsToProcess.length; i += BATCH_SIZE) {
        const batch = itemsToProcess.slice(i, i + BATCH_SIZE);

        self.postMessage({
            type: 'progress',
            message: `Processing items ${i}/${itemsToProcess.length}`,
            current: i,
            total: itemsToProcess.length
        });

        const prompt = `
        Assign a new category to these items.
        Valid Categories: ${JSON.stringify(finalValid)}
        Items: ${JSON.stringify(batch.map(b => ({ id: b.id, name: b.name, old_cat: b.category })))}
        
        Return JSON: { "items": [{ "id": "itemId", "category": "Valid Category Name" }] }
        `;

        const batchResult = await callLLM(aiSettings, prompt);

        if (batchResult && batchResult.items) {
            for (const change of batchResult.items) {
                await db.items.update(change.id, { category: change.category });
            }
        }
        processedCount += batch.length;
    }

    self.postMessage({ type: 'success', count: processedCount });
}

async function auditCategory(categoryName, itemsInCat, validCategories, aiSettings) {
    const BATCH_SIZE = 50;
    const db = await dbPromise;
    let changesCount = 0;

    for (let i = 0; i < itemsInCat.length; i += BATCH_SIZE) {
        const batch = itemsInCat.slice(i, i + BATCH_SIZE);

        self.postMessage({
            type: 'progress',
            message: `Auditing items ${i}/${itemsInCat.length}`,
            current: i,
            total: itemsInCat.length
        });

        const prompt = `
        Audit these items currently in category '${categoryName}'.
        Identify items that DO NOT belong here and suggest a better category from: ${JSON.stringify(validCategories.slice(0, 50))}... (others available).
        If no existing category fits well, suggest a generic standard one.
        
        Items: ${JSON.stringify(batch.map(b => ({ id: b.id, name: b.name })))}
        
        Return JSON: { "changes": [{ "id": "itemId", "new_category": "Better Name" }] }
        Only include items that NEED changing.
        `;

        const batchResult = await callLLM(aiSettings, prompt);
        if (batchResult && batchResult.changes) {
            for (const change of batchResult.changes) {
                await db.items.update(change.id, { category: change.new_category });
                changesCount++;
            }
        }
    }

    self.postMessage({ type: 'success', count: changesCount });
}

async function analyzeParents(items, aiSettings) {
    self.postMessage({ type: 'progress', message: "Clustering items by name (Fuzzy)..." });

    // 1. Fuzzy Clustering
    const clusters = [];
    const THRESHOLD = 0.8; // Similarity threshold (0-1)

    items.forEach(item => {
        // Normalize
        const cleanName = item.name.toLowerCase().replace(/[^\w\s]/g, '').trim();

        // Find best cluster
        let bestCluster = null;
        let bestScore = 0;

        for (const cluster of clusters) {
            // Compare with the first item in cluster (representative)
            const repName = cluster[0]._cleanName;
            const score = getSimilarity(cleanName, repName);

            if (score > bestScore) {
                bestScore = score;
                bestCluster = cluster;
            }
        }

        item._cleanName = cleanName; // Store temp

        if (bestCluster && bestScore >= THRESHOLD) {
            bestCluster.push(item);
        } else {
            clusters.push([item]);
        }
    });

    // 2. Filter out groups with only 1 item
    const multiItemBundles = clusters.filter(group => group.length > 1);

    if (multiItemBundles.length === 0) {
        self.postMessage({ type: 'success', result: { links: [] } });
        return;
    }

    self.postMessage({ type: 'progress', message: `Analyzing ${multiItemBundles.length} item clusters...` });

    const allLinks = [];
    const BATCH_SIZE = 10; // Process 10 bundles at a time to keep prompt size manageable

    for (let i = 0; i < multiItemBundles.length; i += BATCH_SIZE) {
        const batch = multiItemBundles.slice(i, i + BATCH_SIZE);

        // Prepare prompt data
        // Flatten batch but keep structure clear? 
        // Better: items are just list, but we tell AI they are clustered.
        // Actually, let's just send the arrays of items.

        self.postMessage({
            type: 'progress',
            message: `Analyzing batch ${Math.ceil((i + 1) / BATCH_SIZE)}/${Math.ceil(multiItemBundles.length / BATCH_SIZE)}`,
            current: i,
            total: multiItemBundles.length
        });

        const prompt = `
        Identify stock "parent-child" (Kitting) relationships in these item clusters.
        Items in each cluster usually share a base name but differ in quantity (Singles vs Packs vs Cases).
        
        Task:
        For each cluster, find pairs where one item is a "Pack/Case" (Parent) of another item (Child).
        Look for keywords: "Case", "Box", "Pack", "Tie", "Doz", "x12", "x24", "6pk", etc.
        Also infer from implied relationships (e.g. "Coke 330ml" vs "Coke 330ml (24)").

        Input Data (Array of Clusters):
        ${JSON.stringify(batch)}

        Return JSON format:
        {
            "links": [
                { "parent_id": "id_of_case", "child_id": "id_of_single", "conversion_factor": 24 }
            ]
        }
        Only return HIGH CONFIDENCE links.
        `;

        try {
            const result = await callLLM(aiSettings, prompt);
            if (result && result.links) {
                allLinks.push(...result.links);
            }
        } catch (e) {
            console.error("Batch analysis failed:", e);
            // Continue to next batch
        }
    }

    self.postMessage({ type: 'success', result: { links: allLinks } });
}

async function callLLM(settings, prompt) {
    const response = await fetch(`${settings.url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: settings.model || "local-model",
            messages: [
                { role: "system", content: "You are a helpful JSON data assistant. Always return valid JSON." },
                { role: "user", content: prompt }
            ],
            temperature: 0.1
        })
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    let content = json.choices[0].message.content;

    // Basic cleanup
    if (content.includes("```json")) {
        content = content.split("```json")[1].split("```")[0];
    } else if (content.includes("```")) {
        content = content.split("```")[1].split("```")[0];
    }
    return JSON.parse(content);
}

// --- Helpers ---

function getSimilarity(s1, s2) {
    if (s1 === s2) return 1;
    if (!s1 || !s2) return 0;
    const longer = s1.length > s2.length ? s1 : s2;
    const darker = longer.length;
    if (darker === 0) return 1.0;
    return (darker - levenshteinDistance(s1, s2)) / darker;
}

function levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) == a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
            }
        }
    }
    return matrix[b.length][a.length];
}
