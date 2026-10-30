import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = 'test';
// fake-indexeddb clones records with structuredClone, which only round-trips Node's own Blob.
// happy-dom's Blob would come back as an empty object, unlike a real browser's IndexedDB.
(globalThis as { Blob: unknown }).Blob = NodeBlob;
(globalThis as { File: unknown }).File = (await import('node:buffer')).File;
