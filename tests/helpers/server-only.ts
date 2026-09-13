// Vitest runs server modules directly in Node, outside Next.js's
// `react-server` export condition. Alias `server-only` to this empty marker
// in vitest.config.ts so server business logic remains protected in the app
// while still being integration-testable.
export {};
