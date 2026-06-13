<script>
  import { onMount } from 'svelte';
  import { writable, derived } from 'svelte/store';

  const auth = writable(false);
  const currentView = writable('login');
  const models = writable([]);
  const files = writable([]);
  const error = writable('');
  const loading = writable(false);
  const theme = writable('system');
  const excludePaladium = writable(false);

  const osOptions = ['MACOS', 'LINUX', 'WINDOWS'];
  const form = writable({
    name: '',
    version: '',
    description: '',
    dest: '',
    os: []
  });

  const uploadForm = writable({
    model: '',
    path: '',
    file: null,
    name: ''
  });

  const uploadBatchForm = writable({
    model: '',
    path: '',
    files: [],
    mode: 'files'
  });

  const loginForm = writable({ password: '' });

  const blacklistFileForm = writable({
    model: '',
    path: '',
    reason: ''
  });

  const blacklistModelForm = writable({
    name: '',
    reason: ''
  });

  const blacklistedFiles = writable([]);
  const blacklistedModels = writable([]);
  const remoteModels = writable([]);
  const remoteFiles = writable([]);
  const fileSearch = writable('');
  const editingFileId = writable(null);
  const editFileForm = writable({
    id: null,
    name: '',
    model: '',
    path: '',
    file: null
  });

  const filteredRemoteFiles = derived(
    [remoteFiles, files, blacklistFileForm, fileSearch],
    ([$remoteFiles, $files, $blacklistFileForm, $fileSearch]) => {
      const normalized = String($fileSearch || '').trim().toLowerCase();
      const localAsFiles = ($files || []).map((f) => ({ name: f.name, model: f.model, path: f.path, _local: true }));
      const combined = [...($remoteFiles || []).map((f) => ({ ...f, _local: false })), ...localAsFiles];
      return combined
        .filter((item) => {
          if ($blacklistFileForm.model && item.model !== $blacklistFileForm.model) {
            return false;
          }
          if (!normalized) return true;
          return (
            String(item.path || '').toLowerCase().includes(normalized) ||
            String(item.name || '').toLowerCase().includes(normalized)
          );
        })
        .slice(0, 200);
    }
  );

  const allModels = derived([models, remoteModels], ([$models, $remoteModels]) => {
    const map = new Map();
    ($remoteModels || []).forEach((m) => map.set(m.name, { name: m.name, source: 'remote' }));
    ($models || []).forEach((m) => map.set(m.name, { name: m.name, source: 'local' }));
    return Array.from(map.values());
  });

  const osSummary = derived(form, ($form) => {
    if ($form.os.length === 0 || $form.os.length === 3) {
      return 'ALL';
    }
    return $form.os.join(', ');
  });

  function applyTheme(value) {
    const resolved = value === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : value;
    document.documentElement.dataset.theme = resolved;
  }

  onMount(async () => {
    applyTheme('system');
    await refreshStatus();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', () => {
      theme.update((current) => {
        applyTheme(current);
        return current;
      });
    });
  });

  async function refreshStatus() {
    loading.set(true);
    error.set('');
    try {
      const [m, f, bl, remote] = await Promise.all([
        fetchJson('/api/models'),
        fetchJson('/api/files'),
        fetchJson('/api/blacklist'),
        fetchJson('/api/remote-cdn')
      ]);
      if (m.error || f.error || bl.error || remote.error) {
        auth.set(false);
        currentView.set('login');
      } else {
        models.set((m || []).map((item) => ({ ...item, os: item.os || [] })));
        files.set(f || []);
        blacklistedFiles.set((bl.files || []).map((item) => ({ ...item })));
        blacklistedModels.set((bl.models || []).map((item) => ({ ...item })));
        remoteModels.set((remote.models || []).map((item) => ({ ...item, os: item.os || [] })));
        remoteFiles.set(remote.files || []);
        // load app config (exclude_paladium) after authentication
        try {
          const cfg = await fetchJson('/api/config');
          excludePaladium.set(!!cfg.exclude_paladium);
        } catch (e) {
          console.warn('Unable to load app config:', e.message);
        }
        auth.set(true);
        currentView.set('dashboard');
      }
    } catch (e) {
      auth.set(false);
      currentView.set('login');
    } finally {
      loading.set(false);
    }
  }

  async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Request failed');
    }
    return res.json();
  }

  async function login() {
    loading.set(true);
    error.set('');
    try {
      const data = await fetchJson('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $loginForm.password })
      });
      if (data.success) {
        await refreshStatus();
      }
    } catch (e) {
      error.set(e.message);
    } finally {
      loading.set(false);
    }
  }

  async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    auth.set(false);
    currentView.set('login');
  }

  async function createModel() {
    loading.set(true);
    error.set('');
    try {
      const body = { ...$form };
      if ($form.os.length === 3 || $form.os.length === 0) {
        body.os = [];
      }
      const res = await fetchJson('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      models.set(res.models);
      form.set({ name: '', version: '', description: '', dest: '', os: [] });
    } catch (e) {
      error.set(e.message);
    } finally {
      loading.set(false);
    }
  }

  async function refreshRemoteOptions() {
    try {
      const remote = await fetchJson('/api/remote-cdn');
      remoteModels.set((remote.models || []).map((item) => ({ ...item, os: item.os || [] })));
      remoteFiles.set(remote.files || []);
    } catch (err) {
      console.warn('Unable to refresh remote options:', err.message);
    }
  }

  async function setAppConfig(val) {
    loading.set(true);
    error.set('');
    try {
      const res = await fetchJson('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exclude_paladium: !!val })
      });
      excludePaladium.set(!!res.exclude_paladium);
      // refresh remote lists to reflect server-side changes
      await refreshRemoteOptions();
    } catch (e) {
      error.set(e.message);
    } finally {
      loading.set(false);
    }
  }

  async function blacklistRemoteFile(event) {
    event.preventDefault();
    loading.set(true);
    error.set('');
    try {
      const { model, path, reason } = $blacklistFileForm;
      const res = await fetchJson('/api/blacklist/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, path, reason })
      });
      blacklistedFiles.set(res);
      blacklistFileForm.set({ model: '', path: '', reason: '' });
      await refreshRemoteOptions();
    } catch (e) {
      error.set(e.message);
    } finally {
      loading.set(false);
    }
  }

  async function blacklistRemoteModel(event) {
    event.preventDefault();
    loading.set(true);
    error.set('');
    try {
      const { name, reason } = $blacklistModelForm;
      const res = await fetchJson('/api/blacklist/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, reason })
      });
      blacklistedModels.set(res);
      blacklistModelForm.set({ name: '', reason: '' });
    } catch (e) {
      error.set(e.message);
    } finally {
      loading.set(false);
    }
  }

  async function removeBlacklistedFile(id) {
    loading.set(true);
    error.set('');
    try {
      await fetchJson(`/api/blacklist/files/${id}`, { method: 'DELETE' });
      const bl = await fetchJson('/api/blacklist');
      blacklistedFiles.set(bl.files);
      await refreshRemoteOptions();
    } catch (e) {
      error.set(e.message);
    } finally {
      loading.set(false);
    }
  }

  async function removeBlacklistedModel(id) {
    loading.set(true);
    error.set('');
    try {
      await fetchJson(`/api/blacklist/models/${id}`, { method: 'DELETE' });
      const bl = await fetchJson('/api/blacklist');
      blacklistedModels.set(bl.models);
      await refreshRemoteOptions();
    } catch (e) {
      error.set(e.message);
    } finally {
      loading.set(false);
    }
  }

  function startEditingFile(file) {
    editingFileId.set(file.id);
    editFileForm.set({
      id: file.id,
      name: file.name,
      model: file.model,
      path: file.path,
      file: null
    });
  }

  function cancelEditingFile() {
    editingFileId.set(null);
    editFileForm.set({ id: null, name: '', model: '', path: '', file: null });
  }

  async function updateUploadedFile(event) {
    event.preventDefault();
    loading.set(true);
    error.set('');
    try {
      const { id, name, model, path, file } = $editFileForm;
      const payload = new FormData();
      payload.append('name', name);
      payload.append('model', model);
      payload.append('path', path || '');
      if (file) payload.append('file', file);
      const res = await fetch(`/api/files/${id}`, {
        method: 'PUT',
        body: payload
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Update failed');
      }
      files.set(await res.json());
      cancelEditingFile();
      await refreshStatus();
    } catch (e) {
      error.set(e.message);
    } finally {
      loading.set(false);
    }
  }

  async function deleteUploadedFile(id) {
    loading.set(true);
    error.set('');
    try {
      const res = await fetch(`/api/files/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Delete failed');
      }
      files.set(await res.json());
      if ($editingFileId === id) {
        cancelEditingFile();
      }
      await refreshStatus();
    } catch (e) {
      error.set(e.message);
    } finally {
      loading.set(false);
    }
  }

  async function addFile(event) {
    event.preventDefault();
    loading.set(true);
    error.set('');
    try {
      const payload = new FormData();
      payload.append('model', $uploadForm.model);
      payload.append('path', $uploadForm.path || '');
      payload.append('file', $uploadForm.file);
      if ($uploadForm.name) payload.append('name', $uploadForm.name);
      const res = await fetch('/api/files', {
        method: 'POST',
        body: payload
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Upload failed');
      }
      files.set(await res.json());
      uploadForm.set({ model: '', path: '', file: null });
      document.querySelector('#upload-file').value = '';
      uploadForm.update((s) => ({ ...s, name: '' }));
    } catch (e) {
      error.set(e.message);
    } finally {
      loading.set(false);
    }
  }

  async function addFilesBatch(event) {
    event.preventDefault();
    loading.set(true);
    error.set('');
    try {
      const { model, path: basePath, files } = $uploadBatchForm;
      if (!model) throw new Error('model is required');
      if (!files || files.length === 0) throw new Error('no files selected');
      const payload = new FormData();
      payload.append('model', model);
      if (basePath) payload.append('path', basePath);
      for (const f of files) {
        const relative = f.webkitRelativePath || f.relativePath || f.name;
        const normalized = (basePath ? (basePath.replace(/\/+$/, '') + '/') : '') + relative.replace(/^\/+/, '');
        payload.append('files', f, normalized);
      }
      const res = await fetch('/api/files/batch', {
        method: 'POST',
        body: payload
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Batch upload failed');
      }
      files.set(await res.json());
      uploadBatchForm.set({ model: '', path: '', files: [] });
      const el = document.querySelector('#upload-files');
      if (el) el.value = '';
      await refreshStatus();
    } catch (e) {
      error.set(e.message);
    } finally {
      loading.set(false);
    }
  }

  function toggleTheme() {
    theme.update((value) => {
      const next = value === 'light' ? 'dark' : value === 'dark' ? 'system' : 'light';
      applyTheme(next);
      return next;
    });
  }
</script>

<style>
  :global(:root) {
    color-scheme: light;
    --bg: #ffffff;
    --fg: #111111;
    --surface: #f6f7fb;
    --border: #d9d9d9;
    --accent: #0066cc;
    --danger: #b00020;
  }
  :global([data-theme='dark']) {
    color-scheme: dark;
    --bg: #0b0d12;
    --fg: #ecf0ff;
    --surface: #141a26;
    --border: #314158;
    --accent: #4dabf7;
    --danger: #ff6b82;
  }
  body {
    margin: 0;
    font-family: system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
  }
  .app {
    
  }
  .panel {
    width: 90%;
    max-width: 90%;
    margin: 0 auto 1rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1rem;
  }
  h1, h2, h3 {
    margin: 0 0 0.75rem 0;
  }
  .row { display: flex; flex-wrap: wrap; gap: 1rem; }
  .field { flex: 1 1 260px; display: flex; flex-direction: column; gap: 0.35rem; }
  label { font-size: 0.95rem; }
  input, textarea, select, button { font: inherit; }
  input, textarea, select {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.7rem;
    background: var(--bg);
    color: var(--fg);
  }
  button {
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 10px;
    padding: 0.75rem 1rem;
    cursor: pointer;
  }
  button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  button:disabled { opacity: 0.6; cursor: not-allowed; }
  .error { color: var(--danger); margin-bottom: 1rem; }
  .table { width: 100%; border-collapse: collapse; }
  .table th, .table td { padding: 0.75rem; border: 1px solid var(--border); text-align: left; }
  .table th { background: rgba(0,0,0,0.04); }
  .action-cell {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: flex-end;
    align-items: center;
    min-width: 0;
  }
  .action-cell button {
    flex: 1 1 auto;
    min-width: 5rem;
  }
  .right { text-align: right; }
  .tiny { font-size: 0.85rem; color: var(--fg); opacity: 0.75; }
</style>

<div class="app">
  <header class="row" style="justify-content: space-between; align-items: center; margin-bottom: 1rem;">
    <div>
      <h1>CDN Admin</h1>
      <p class="tiny">Light / dark mode is automatic. Use the toggle to cycle themes.</p>
    </div>
  </header>

  {#if $currentView === 'login'}
    <section class="panel">
      <h2>Admin login</h2>
      {#if $error}<div class="error">{$error}</div>{/if}
      <div class="field">
        <label for="password">Password</label>
        <input id="password" type="password" bind:value={$loginForm.password} disabled={$loading} />
      </div>
      <button on:click={login} disabled={$loading}>Login</button>
    </section>
  {:else}
    <div style="display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem;">
      <button on:click={logout} class="secondary">Logout</button>
      <div style="display:flex;align-items:center;gap:0.75rem;">
      <label style="display:flex;align-items:center;gap:0.5rem;" title="When enabled, Paladium CDN files will be excluded from /manifest.json">
        <input type="checkbox" checked={$excludePaladium} on:change={async (e) => await setAppConfig(e.target.checked)} />
        <span class="tiny">Exclude Paladium CDN from manifest</span>
      </label>
      <button type="button" class="secondary" on:click={toggleTheme}>Toggle theme</button>
    </div>
      <button on:click={refreshStatus} class="secondary">Refresh data</button>
    </div>

    {#if $error}<div class="error">{$error}</div>{/if}

    <section class="panel">
      <h2>File upload</h2>
      <form on:submit|preventDefault={addFile} class="row">
        <div class="field">
          <label for="upload-model">Model</label>
          <select id="upload-model" bind:value={$uploadForm.model} required>
            <option value="">Choose a model</option>
            {#each $models as model}
              <option value={model.name}>{model.name}</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label for="upload-path">Relative path</label>
          <input id="upload-path" type="text" placeholder="com/example/file.jar" bind:value={$uploadForm.path} />
        </div>
        <div class="field">
          <label for="upload-file">File</label>
          <input id="upload-file" type="file" on:change={(e) => uploadForm.update((s) => ({ ...s, file: e.target.files[0] }))} required />
        </div>
        <div class="field">
          <label for="upload-name">Name (optional)</label>
          <input id="upload-name" type="text" placeholder="custom-name.jar (optional)" bind:value={$uploadForm.name} />
          <div class="tiny">If left empty the original filename will be used.</div>
        </div>
        <div class="field" style="align-self: flex-end; min-width: 180px;">
          <button type="submit" disabled={$loading}>Upload</button>
        </div>
      </form>

      <form on:submit|preventDefault={addFilesBatch} class="row" style="margin-top: 1rem; border-top: 1px dashed var(--border); padding-top: 1rem;">
        <div class="field">
          <label for="upload-batch-model">Model (batch)</label>
          <select id="upload-batch-model" value={$uploadBatchForm.model} on:change={(e) => uploadBatchForm.update((s) => ({ ...s, model: e.target.value }))} required>
            <option value="">Choose a model</option>
            {#each $models as model}
              <option value={model.name}>{model.name}</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label for="upload-batch-path">Base path (optional)</label>
          <input id="upload-batch-path" type="text" placeholder="mods/" value={$uploadBatchForm.path} on:input={(e) => uploadBatchForm.update((s) => ({ ...s, path: e.target.value }))} />
        </div>
        <div class="field">
          <label>Selection mode</label>
          <div class="row" style="gap: 0.75rem; align-items: center;">
            <label><input type="radio" name="batchMode" value="files" checked={$uploadBatchForm.mode === 'files'} on:change={(e) => uploadBatchForm.update((s) => ({ ...s, mode: e.target.value, files: [] }))} /> Multiple files</label>
            <label><input type="radio" name="batchMode" value="folder" checked={$uploadBatchForm.mode === 'folder'} on:change={(e) => uploadBatchForm.update((s) => ({ ...s, mode: e.target.value, files: [] }))} /> Folder</label>
          </div>
          {#if $uploadBatchForm.mode === 'files'}
            <input id="upload-files" type="file" multiple on:change={(e) => uploadBatchForm.update((s) => ({ ...s, files: Array.from(e.target.files) }))} />
          {:else}
            <input id="upload-files-folder" type="file" webkitdirectory directory multiple on:change={(e) => uploadBatchForm.update((s) => ({ ...s, files: Array.from(e.target.files) }))} />
          {/if}
          <div class="tiny">Select multiple files or a folder (folder picker supported in Chromium-based browsers).</div>
        </div>
        <div class="field" style="align-self: flex-end; min-width: 180px;">
          <button type="submit" disabled={$loading}>Batch upload</button>
        </div>
      </form>
    </section>

    <section class="panel">
      <h2>Create model</h2>
      <div class="row">
        <div class="field"><label for="model-name">Name</label><input id="model-name" bind:value={$form.name} required /></div>
        <div class="field"><label for="model-version">Version</label><input id="model-version" bind:value={$form.version} required /></div>
        <div class="field"><label for="model-dest">Destination</label><input id="model-dest" bind:value={$form.dest} required /></div>
      </div>
      <div class="field"><label for="model-description">Description</label><textarea id="model-description" rows="2" bind:value={$form.description}></textarea></div>
      <div class="field">
        <div class="tiny">OS</div>
        <div class="row" style="gap: 0.75rem;">
          {#each osOptions as os}
            <label><input type="checkbox" value={os} checked={$form.os.includes(os)} on:change={() => {
              const next = $form.os.includes(os)
                ? $form.os.filter((item) => item !== os)
                : [...$form.os, os];
              form.set({ ...$form, os: next });
            }} /> {os}</label>
          {/each}
        </div>
        <div class="tiny">Displayed as {osSummary}</div>
      </div>
      <button on:click={createModel} disabled={$loading}>Create model</button>
    </section>

    <section class="panel">
      <h2>Blacklist remote CDN entries</h2>
      <div class="row" style="flex-wrap: wrap; gap: 1rem;">
        <form on:submit|preventDefault={blacklistRemoteFile} class="panel" style="flex: 1 1 320px; min-width: 320px;">
          <h3>Blacklist file</h3>
          <div class="field">
            <label for="blacklist-file-model">Filter by model</label>
            <select id="blacklist-file-model" bind:value={$blacklistFileForm.model} on:change={() => blacklistFileForm.update((s) => ({ ...s, path: '' }))}>
              <option value="">All models (remote + local)</option>
              {#each $allModels as model}
                <option value={model.name}>{model.name}</option>
              {/each}
            </select>
          </div>
          <div class="field"><label for="file-search">Search files</label><input id="file-search" type="search" placeholder="Search remote files by name or path" bind:value={$fileSearch} /></div>
          <div class="field">
            <label for="blacklist-file-path">Select file path</label>
            <select id="blacklist-file-path" bind:value={$blacklistFileForm.path} required>
              <option value="">Choose a remote or local file</option>
              {#each $filteredRemoteFiles as file}
                <option value={file.path}>{file.model} — {file.path}</option>
              {/each}
            </select>
          </div>
          <div class="field"><label for="blacklist-file-reason">Reason (optional)</label><input id="blacklist-file-reason" bind:value={$blacklistFileForm.reason} /></div>
          <button type="submit" disabled={$loading}>Blacklist file</button>
        </form>

        <form on:submit|preventDefault={blacklistRemoteModel} class="panel" style="flex: 1 1 320px; min-width: 320px;">
          <h3>Blacklist model</h3>
          <div class="field">
            <label for="blacklist-model-name">Model name</label>
            <select id="blacklist-model-name" bind:value={$blacklistModelForm.name} required>
              <option value="">Choose a model (remote or local)</option>
              {#each $allModels as model}
                <option value={model.name}>{model.name}</option>
              {/each}
            </select>
          </div>
          <div class="field"><label for="blacklist-model-reason">Reason (optional)</label><input id="blacklist-model-reason" bind:value={$blacklistModelForm.reason} /></div>
          <button type="submit" disabled={$loading}>Blacklist model</button>
        </form>
      </div>

      {#if $blacklistedFiles.length}
        <h3>Blacklisted remote files</h3>
        <table class="table">
          <thead><tr><th>Model</th><th>Path</th><th>Name</th><th>Reason</th><th>Added</th><th></th></tr></thead>
          <tbody>
            {#each $blacklistedFiles as item}
              <tr>
                <td>{item.model}</td>
                <td>{item.path}</td>
                <td>{item.name}</td>
                <td>{item.reason || '—'}</td>
                <td>{new Date(item.blacklisted_at).toLocaleString()}</td>
                <td><button type="button" class="secondary" on:click={() => removeBlacklistedFile(item.id)} disabled={$loading}>Remove</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      {#if $blacklistedModels.length}
        <div style="margin-top: 1.25rem;">
          <h3>Blacklisted remote models</h3>
        </div>
        <table class="table">
          <thead><tr><th>Name</th><th>Reason</th><th>Added</th><th></th></tr></thead>
          <tbody>
            {#each $blacklistedModels as item}
              <tr>
                <td>{item.name}</td>
                <td>{item.reason || '—'}</td>
                <td>{new Date(item.blacklisted_at).toLocaleString()}</td>
                <td><button type="button" class="secondary" on:click={() => removeBlacklistedModel(item.id)} disabled={$loading}>Remove</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>

    <section class="panel">
      <h2>Models</h2>
      <table class="table">
        <thead><tr><th>Name</th><th>Version</th><th>Dest</th><th>OS</th><th>Source</th><th>Description</th></tr></thead>
        <tbody>
          {#each $models as model}
            <tr>
              <td>{model.name}</td>
              <td>{model.version}</td>
              <td>{model.dest}</td>
              <td>{(model.os || []).length === 0 ? 'ALL' : (model.os || []).join(', ')}</td>
              <td>{model.source === 'remote' ? 'remote' : 'local'}</td>
              <td>{model.description}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
    {#if $editingFileId}
      <section class="panel">
        <h2>Edit uploaded file</h2>
        <form on:submit|preventDefault={updateUploadedFile} class="row">
          <div class="field"><label for="edit-file-name">Name</label><input id="edit-file-name" value={$editFileForm.name} on:input={(e) => editFileForm.update((s) => ({ ...s, name: e.target.value }))} required /></div>
          <div class="field">
            <label for="edit-file-model">Model</label>
            <select id="edit-file-model" value={$editFileForm.model} on:change={(e) => editFileForm.update((s) => ({ ...s, model: e.target.value }))} required>
              <option value="">Choose a model</option>
              {#each $models as model}
                <option value={model.name}>{model.name}</option>
              {/each}
            </select>
          </div>
          <div class="field"><label for="edit-file-path">Relative path</label><input id="edit-file-path" type="text" value={$editFileForm.path} on:input={(e) => editFileForm.update((s) => ({ ...s, path: e.target.value }))} required /></div>
          <div class="field"><label for="edit-file-upload">Replace file (optional)</label><input id="edit-file-upload" type="file" on:change={(e) => editFileForm.update((s) => ({ ...s, file: e.target.files[0] }))} /></div>
          <div class="field" style="align-self: flex-end; min-width: 180px; display: flex; gap: 0.5rem;">
            <button type="submit" disabled={$loading}>Save changes</button>
            <button type="button" class="secondary" on:click={cancelEditingFile} disabled={$loading}>Cancel</button>
          </div>
        </form>
      </section>
    {/if}
    <section class="panel">
      <h2>Files</h2>
      <table class="table">
        <thead><tr><th>Name</th><th>Model</th><th>Path</th><th>Size</th><th>SHA-1</th><th>Downloads</th><th>Uploaded</th><th>Actions</th></tr></thead>
        <tbody>
          {#each $files as file}
            <tr>
              <td><a href={file.url} target="_blank" rel="noreferrer">{file.name}</a></td>
              <td>{file.model}</td>
              <td>{file.path}</td>
              <td class="right">{file.size}</td>
              <td class="tiny">{file.sha1}</td>
              <td class="right">{file.download_count}</td>
              <td>{new Date(file.uploaded_at).toLocaleString()}</td>
              <td class="action-cell"><button type="button" class="secondary" on:click={() => startEditingFile(file)} disabled={$loading}>Edit</button><button type="button" class="secondary" on:click={() => deleteUploadedFile(file.id)} disabled={$loading}>Delete</button></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}
</div>
