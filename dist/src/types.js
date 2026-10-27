// Shapes shared between modules.
//
// Types only: this file must never import anything at runtime, so nothing can
// depend on it in a way that forms a cycle (`check-modules.ts` keeps it at
// layer 0). Everywhere else imports from here with `import type`.
export {};
