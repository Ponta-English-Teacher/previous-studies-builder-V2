// ==== IndexedDB helper for Previous Studies Builder ====
// Small, dependency-free module. Stores exactly one project record (the
// student's current work) under a fixed key. No framework, no external
// database service -- just the browser's built-in IndexedDB.
//
// Exposes a single global: ProjectDB = { saveProject, loadProject, deleteProject }

const ProjectDB = (() => {
  const DB_NAME = 'previousStudiesBuilderDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'project';
  const PROJECT_KEY = 'current';

  function openDB() {
    if (!window.indexedDB) {
      return Promise.reject(new Error('IndexedDB is not available in this browser.'));
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB.'));
    });
  }

  async function saveProject(data) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(data, PROJECT_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('Failed to save project.'));
      tx.onabort = () => reject(tx.error || new Error('Save transaction aborted.'));
    });
  }

  async function loadProject() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(PROJECT_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Failed to load project.'));
    });
  }

  async function deleteProject() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(PROJECT_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('Failed to delete project.'));
      tx.onabort = () => reject(tx.error || new Error('Delete transaction aborted.'));
    });
  }

  return { saveProject, loadProject, deleteProject };
})();
