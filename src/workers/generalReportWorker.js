
self.onmessage = function (e) {
    const { type, payload } = e.data;

    try {
        if (type === 'GENERATE_SHIFTS') {
            const result = generateShiftReports(payload);
            self.postMessage({ type: 'Re:GENERATE_SHIFTS', success: true, data: result });
        } else if (type === 'GENERATE_SUMMARY') {
            const result = generateSalesSummary(payload);
            self.postMessage({ type: 'Re:GENERATE_SUMMARY', success: true, data: result });
        }
    } catch (error) {
        self.postMessage({ type: 'ERROR', message: error.message, stack: error.stack });
    }
};

function generateSalesSummary(payload) {
    const { transactions, items, startDate, endDate } = payload;
    const start = new Date(startDate);
    const end = new Date(endDate);

    // Create Item Cost Map for fast lookup
    const itemMap = new Map();
    items.forEach(i => itemMap.set(i.id, i));

    let totalRevenue = 0;
    let totalCost = 0;
    let totalTax = 0; // If you have tax logic
    let transactionCount = 0;

    const paymentMethods = {};
    const categorySales = {};

    transactions.forEach(tx => {
        const d = new Date(tx.timestamp);
        if (d >= start && d <= end && !tx.is_voided) {
            transactionCount++;
            totalRevenue += parseFloat(tx.total_amount || 0);

            // Payment Method Breakdown
            const method = tx.payment_method || 'Cash';
            if (!paymentMethods[method]) paymentMethods[method] = 0;
            paymentMethods[method] += parseFloat(tx.total_amount || 0);

            // Line Item Analysis for Cost & Category
            if (tx.items && Array.isArray(tx.items)) {
                tx.items.forEach(lineItem => {
                    const itemDef = itemMap.get(lineItem.id);
                    // fallback to lineItem.cost if stored snapshot exists, else current cost
                    const cost = parseFloat(lineItem.cost || (itemDef ? itemDef.cost_price : 0) || 0);
                    const qty = parseFloat(lineItem.qty || 0);
                    const lineTotal = (parseFloat(lineItem.price || 0) * qty);

                    totalCost += (cost * qty);

                    // Category aggregation
                    const cat = (itemDef ? itemDef.category : 'Uncategorized') || 'Uncategorized';
                    if (!categorySales[cat]) categorySales[cat] = 0;
                    categorySales[cat] += lineTotal;
                });
            }
        }
    });

    const grossProfit = totalRevenue - totalCost;
    const margin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

    return {
        summary: {
            totalRevenue,
            totalCost,
            grossProfit,
            margin,
            transactionCount,
            avgTicket: transactionCount > 0 ? totalRevenue / transactionCount : 0
        },
        paymentMethods,
        categorySales
    };
}

function generateShiftReports(payload) {
    const { shifts, transactions, startDate, endDate } = payload;
    const start = new Date(startDate);
    const end = new Date(endDate);

    // Filter shifts by date range
    const filteredShifts = shifts.filter(s => {
        const d = new Date(s.start_time);
        return d >= start && d <= end;
    });

    // Sort by Date Descending
    filteredShifts.sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

    // Calculate Aggregates
    const totalShifts = filteredShifts.length;
    let totalVariance = 0;
    let totalCashout = 0;
    let totalSalesGlobal = 0;

    filteredShifts.forEach(s => {
        const sStart = new Date(s.start_time);
        const sEnd = s.end_time ? new Date(s.end_time) : new Date();
        const userEmailNormalized = (s.user_id || "").trim().toLowerCase();

        // 1. Calculate Sales (Cash only) for this shift
        let shiftSales = 0;
        let shiftExchangeCash = 0;

        if (transactions && transactions.length) {
            transactions.forEach(tx => {
                const txTime = new Date(tx.timestamp);
                const txUserNormalized = (tx.user_email || "").trim().toLowerCase();

                // Regular Sales matching normalized user and time
                if (txUserNormalized === userEmailNormalized && txTime >= sStart && txTime <= sEnd && !tx.is_voided) {
                    const pm = (tx.payment_method || 'Cash').toLowerCase();
                    if (pm === 'cash') {
                        shiftSales += parseFloat(tx.total_amount || 0);
                    }
                }

                // Exchanges/Returns within this shift
                if (tx.exchanges && Array.isArray(tx.exchanges)) {
                    tx.exchanges.forEach(exch => {
                        const exchTime = new Date(exch.timestamp);
                        const exchUserNormalized = (exch.processed_by || "").trim().toLowerCase();
                        if (exchUserNormalized === userEmailNormalized && exchTime >= sStart && exchTime <= sEnd) {
                            const returnedTotal = (exch.returned || []).reduce((sum, item) => sum + (parseFloat(item.selling_price || 0) * (parseFloat(item.qty) || 1)), 0);
                            const takenTotal = (exch.taken || []).reduce((sum, item) => sum + (parseFloat(item.selling_price || 0) * (parseFloat(item.qty) || 1)), 0);
                            shiftExchangeCash += (takenTotal - returnedTotal);
                        }
                    });
                }
            });
        }

        // 2. Adjustments
        const shiftAdjustments = (s.adjustments || []).reduce((sum, adj) => sum + (parseFloat(adj.amount) || 0), 0);

        // 3. Dynamic Expected Cash (Gross Accountability)
        // Formula: Opening + Sales + Exchanges + Adjustments
        const opening = parseFloat(s.opening_cash || 0);
        const dynamicExpectedAccountability = opening + shiftSales + shiftExchangeCash + shiftAdjustments;

        // 4. Turnover & Variance
        const closing = parseFloat(s.closing_cash || 0);
        const cashoutTotalInShiftObj = (s.remittances || []).reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
        const expensesTotalInShiftObj = (s.closing_receipts || []).reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);

        // Expected in Drawer = Accountability - Cashout - Expenses
        const expectedInDrawer = dynamicExpectedAccountability - cashoutTotalInShiftObj - expensesTotalInShiftObj;

        const turnover = closing + cashoutTotalInShiftObj + expensesTotalInShiftObj;
        const variance = (s.status === 'closed') ? (turnover - dynamicExpectedAccountability) : 0;

        // Cache results back to shift object for the mapper
        s._dynamicExpected = expectedInDrawer; // We show "Expected in Drawer" in the table
        s._calculatedSales = shiftSales;
        s._calculatedVariance = variance;
        s._calculatedTurnover = turnover;
        s._calculatedCashout = cashoutTotalInShiftObj;
        s._grossAccountability = dynamicExpectedAccountability;

        totalSalesGlobal += shiftSales;
        if (s.status === 'closed') {
            totalVariance += variance;
            totalCashout += cashoutTotalInShiftObj;
        }
    });

    return {
        shifts: filteredShifts.map(s => ({
            id: s.id,
            start_time: s.start_time,
            end_time: s.end_time,
            status: s.status,
            user_id: s.user_id,
            opening_cash: parseFloat(s.opening_cash || 0),
            closing_cash: parseFloat(s.closing_cash || 0),
            expected_cash: s._dynamicExpected,
            cashout: s._calculatedCashout,
            total_sales: s._calculatedSales,
            adjustment_count: (s.adjustments || []).length,
            variance: s._calculatedVariance,
            turnover: s._calculatedTurnover,
            forced_closed: s.forced_closed,
            remittance_total: s._calculatedCashout,
            gross_accountability: s._grossAccountability
        })),
        summary: {
            totalShifts,
            totalVariance,
            totalCashout,
            totalSales: totalSalesGlobal
        }
    };
}
