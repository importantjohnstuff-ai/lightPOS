# Implementation Plan: Expenses Quick Sum Function

## Objective
Enable users to select multiple expenses from the table and immediately see the total sum of the selected items.

## Proposed Changes

### 1. Update UI Layout (`src/modules/expenses.js`)

**A. Floating Summary Widget**
*   Inject a hidden HTML container for the "Quick Sum" display.
*   **Location**: Fixed at the bottom-center of the screen.
*   **Styling**:
    *   `fixed bottom-8 left-1/2 transform -translate-x-1/2`
    *   `bg-gray-900 text-white px-6 py-3 rounded-full shadow-2xl`
    *   `flex items-center gap-4 z-50 transition-all duration-300 translate-y-20 opacity-0` (Hidden state)
    *   `translate-y-0 opacity-100` (Visible state)
*   **Content**:
    *   Text: "X items selected"
    *   Text: **₱ Total** (Large/Bold)
    *   Button: "Clear Selection" (Optional, small icon)

**B. Update Expenses Table**
*   **Header**: Add a checkbox `<th>` at the very first column.
    *   Includes a "Select All" checkbox (`<input type="checkbox" id="select-all-expenses">`).
*   **Rows**: Add a checkbox `<td>` at the very first column.
    *   `<input type="checkbox" class="expense-checkbox" data-amount="...">`

### 2. Implement Logic (`fetchExpenses` & Event Listeners)

**A. Render Logic**
*   Update `fetchExpenses` to include the checkbox column in both `thead` and generated `tr` rows.
*   Store the expense amount in the checkbox's `data-amount` attribute or use a map.

**B. Interaction Logic**
*   **Checkbox Change**:
    *   When any `.expense-checkbox` changes:
        *   Recalculate total of all checked boxes.
        *   Update the Floating Summary Widget text.
        *   Show/Hide the widget based on `selectedCount > 0`.
*   **Select All**:
    *   When `#select-all-expenses` changes:
        *   Set all `.expense-checkbox` checked state to match.
        *   Trigger recalculation.

## Verification
1.  Open Expenses module.
2.  Click checkboxes on different rows.
3.  Verify the floating pill appears with correct count and sum.
4.  Verify "Select All" toggles all rows.
5.  Verify filtering re-renders the table and resets selection (or handles it gracefully).
