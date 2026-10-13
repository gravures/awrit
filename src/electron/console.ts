export const console_ = { ...console };
// Disable all console logging
console.log = console.error = console.warn = () => {};
