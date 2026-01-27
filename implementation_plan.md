# Implementation Plan: Add Invoice Number to Expenses Table

## Objective
Display the "Sales Invoice Number" in the Expenses Module's main table view. This complements the recently added field in the "Record Expense" modal.

## User Request
"I would like you to also add in the Invoice Number into the 'Expenses Module' Expense table"

## Proposed Changes

### 1. Modify `src/modules/expenses.js`

**Function: `fetchExpenses`**

*   **Update Table Header (`thead`)**:
    *   Add a new table header cell `<th>` for "Invoice No.".
    *   Proposed Position: Between "Supplier" and "Amount".
    *   Resulting Headers: Date, Description, Category, Supplier, **Invoice No.**, Amount, User, Actions.

*   **Update Table Body (`tbody`)**:
    *   In the row generation loop, insert the corresponding data cell `<td>`.
    *   Value: `data.invoice_number || '-'` (Display a dash if empty).
    *   Ensure match with the header position (Column 5).

## Verification
*   Reload the Expenses view.
*   Verify that the new column "Invoice No." appears.
*   Verify that existing expenses show "-" (or data if recently added).
*   Add a new expense with an Invoice Number and verify it appears in the table.
