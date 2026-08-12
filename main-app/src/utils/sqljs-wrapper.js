// src/utils/sqljs-wrapper.js

// Re-export initSqlJs from the global scope
export const initSqlJs = (typeof window !== 'undefined') ? window.initSqlJs : null;
