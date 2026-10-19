<script>
  import { onMount } from 'svelte';

  const emptyModel = { name: '', version: '', dest: '', description: '', os: [] };
  let authenticated = false;
  let password = '';
  let models = [];
  let files = [];
  let config = { exclude_paladium: false };
  let notice = '';
  let error = '';
  let busy = false;
  let theme = 'light';
  let modelForm = { ...emptyModel };
  let editingModel = null;
  let upload = { model: '', path: '', file: null };
  let batchUpload = { model: '', files: [] };
  let directoryUploadProgress = null;
  let fileSearch = '';
  let fileSort = 'name';
  let selectedFileModels = [];
  let visibleFiles = [];

  const request = async (url, options = {}) => {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  };

  const message = (text) => { notice = text; error = ''; };
  const fail = (err) => { error = err.message || 'Something went wrong.'; notice = ''; };

  async function load() {
    const [nextModels, nextFiles, nextConfig] = await Promise.all([
      request('/api/models'), request('/api/files'), request('/api/config')
    ]);
    models = nextModels;
    files = nextFiles;
    config = nextConfig;
  }

  onMount(async () => {
    theme = localStorage.getItem('cdn-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    try { await load(); authenticated = true; } catch (_) { authenticated = false; }
  });

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cdn-theme', theme);
  }

  async function login() {
    busy = true;
    try {
      await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      password = '';
      await load();
      authenticated = true;
    } catch (err) { fail(err); } finally { busy = false; }
  }

  async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    authenticated = false;
  }

  async function createModel() {
    busy = true;
    try {
      await request('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(modelForm) });
      modelForm = { ...emptyModel };
      await load();
      message('Model created.');
    } catch (err) { fail(err); } finally { busy = false; }
  }

  function startEditingModel(model) { editingModel = { ...model, os: [...model.os] }; }

  async function saveModel() {
    busy = true;
    try {
      await request(`/api/models/${encodeURIComponent(editingModel.name)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editingModel) });
      editingModel = null; await load(); message('Model updated.');
    } catch (err) { fail(err); } finally { busy = false; }
  }

  async function setModelExcluded(model) {
    busy = true;
    try {
      await request(`/api/models/${encodeURIComponent(model.name)}/excluded`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ excluded: !model.excluded }) });
      await load(); message(model.excluded ? 'Model included in the manifest.' : 'Model excluded from the manifest.');
    } catch (err) { fail(err); } finally { busy = false; }
  }

  async function deleteModel(model) {
    if (!confirm(`Delete ${model.name} and its uploaded files? This cannot be undone.`)) return;
    busy = true;
    try { const result = await request(`/api/models/${encodeURIComponent(model.name)}`, { method: 'DELETE' }); await load(); message(`Model deleted${result.deletedFiles ? ` with ${result.deletedFiles} file${result.deletedFiles === 1 ? '' : 's'}` : ''}.`); }
    catch (err) { fail(err); } finally { busy = false; }
  }

  function toggleEditingOs(os) { editingModel = { ...editingModel, os: editingModel.os.includes(os) ? editingModel.os.filter((value) => value !== os) : [...editingModel.os, os] }; }

  async function uploadFile() {
    if (!upload.file) return fail(new Error('Choose a file to upload.'));
    busy = true;
    try {
      const body = new FormData();
      body.append('model', upload.model);
      body.append('path', upload.path);
      body.append('file', upload.file);
      await request('/api/files', { method: 'POST', body });
      upload = { model: '', path: '', file: null };
      document.querySelector('#file-input').value = '';
      await load();
      message('File uploaded.');
    } catch (err) { fail(err); } finally { busy = false; }
  }

  function folderRelativePath(file) {
    const selectedPath = String(file.webkitRelativePath || file.name).replace(/\\/g, '/');
    const firstSlash = selectedPath.indexOf('/');
    return firstSlash === -1 ? selectedPath : selectedPath.slice(firstSlash + 1);
  }

  function chooseDirectory(event) {
    batchUpload = { ...batchUpload, files: Array.from(event.currentTarget.files || []) };
    directoryUploadProgress = null;
  }

  async function uploadDirectory() {
    if (!batchUpload.files.length) return fail(new Error('Choose a directory to upload.'));
    const selectedModel = batchUpload.model;
    const selectedFiles = batchUpload.files;
    busy = true;
    directoryUploadProgress = { completed: 0, total: selectedFiles.length };
    try {
      for (let index = 0; index < selectedFiles.length; index += 1) {
        const file = selectedFiles[index];
        const body = new FormData();
        body.append('model', selectedModel);
        body.append('file', file);
        body.append('path', folderRelativePath(file));
        await request('/api/files', { method: 'POST', body });
        directoryUploadProgress = { completed: index + 1, total: selectedFiles.length };
      }
      batchUpload = { model: '', files: [] };
      document.querySelector('#directory-input').value = '';
      await load();
      message(`${directoryUploadProgress.total} file${directoryUploadProgress.total === 1 ? '' : 's'} uploaded.`);
      directoryUploadProgress = null;
    } catch (err) {
      const completed = directoryUploadProgress?.completed || 0;
      fail(new Error(`Upload stopped after ${completed} file${completed === 1 ? '' : 's'}: ${err.message || 'Something went wrong.'}`));
    } finally { busy = false; }
  }

  async function removeFile(file) {
    if (!confirm(`Delete ${file.name}?`)) return;
    busy = true;
    try { await request(`/api/files/${file.id}`, { method: 'DELETE' }); await load(); message('File deleted.'); }
    catch (err) { fail(err); } finally { busy = false; }
  }

  async function replaceFile(file, event) {
    const replacement = event.currentTarget.files[0];
    if (!replacement) return;
    event.currentTarget.value = '';
    busy = true;
    try {
      const body = new FormData();
      body.append('file', replacement);
      await request(`/api/files/${file.id}`, { method: 'PUT', body });
      await load();
      message(`${file.name} replaced.`);
    } catch (err) { fail(err); } finally { busy = false; }
  }

  async function updateConfig() {
    busy = true;
    try { config = await request('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }); message('Publishing settings saved.'); }
    catch (err) { fail(err); } finally { busy = false; }
  }

  function toggleOs(os) {
    modelForm = { ...modelForm, os: modelForm.os.includes(os) ? modelForm.os.filter((value) => value !== os) : [...modelForm.os, os] };
  }

  function toggleFileModel(model) {
    selectedFileModels = selectedFileModels.includes(model)
      ? selectedFileModels.filter((name) => name !== model)
      : [...selectedFileModels, model];
  }

  const size = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

  $: {
    const search = fileSearch.trim().toLocaleLowerCase();
    const selectedModels = new Set(selectedFileModels);
    visibleFiles = files
      .filter((file) => (!search || file.name.toLocaleLowerCase().includes(search)) && (!selectedModels.size || selectedModels.has(file.model)))
      .slice()
      .sort((left, right) => {
        if (fileSort === 'size') return right.size - left.size || left.name.localeCompare(right.name);
        if (fileSort === 'model') return left.model.localeCompare(right.model) || left.name.localeCompare(right.name);
        return left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
      });
  }
</script>

<svelte:head><title>CDN Console</title></svelte:head>

{#if !authenticated}
  <main class="login-shell">
    <section class="login-card">
      <div class="brand"><span class="brand-mark">↗</span><span>CDN Console</span></div>
      <h1>Welcome back</h1>
      <p>Sign in to publish and manage your files.</p>
      {#if error}<div class="alert error">{error}</div>{/if}
      <form on:submit|preventDefault={login}>
        <label for="password">Admin password</label>
        <input id="password" type="password" bind:value={password} autofocus required disabled={busy} />
        <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <button class="theme-button" type="button" on:click={toggleTheme}>{theme === 'dark' ? 'Use light theme' : 'Use dark theme'}</button>
    </section>
  </main>
{:else}
  <main class="shell">
    <header>
      <a class="brand" href="/"><span class="brand-mark">↗</span><span>CDN Console</span></a>
      <nav><a href="/manifest.json" target="_blank" rel="noreferrer">View manifest</a><button class="text-button" on:click={toggleTheme} aria-label="Toggle color theme">{theme === 'dark' ? 'Light theme' : 'Dark theme'}</button><button class="text-button" on:click={logout}>Sign out</button></nav>
    </header>

    <section class="hero"><div><p class="eyebrow">CONTENT DELIVERY</p><h1>Your release files, in one place.</h1><p>Manage models, upload artifacts, and publish a dependable manifest.</p></div><div class="stats"><div><strong>{models.length}</strong><span>Models</span></div><div><strong>{files.length}</strong><span>Files</span></div></div></section>
    {#if notice}<div class="alert success">{notice}</div>{/if}
    {#if error}<div class="alert error">{error}</div>{/if}

    <div class="grid">
      <section class="card">
        <div class="card-heading"><div><p class="eyebrow">01</p><h2>Create a model</h2></div></div>
        <form on:submit|preventDefault={createModel} class="form-grid">
          <label>Name<input bind:value={modelForm.name} placeholder="client" required /></label>
          <label>Version<input bind:value={modelForm.version} placeholder="1.0.0" required /></label>
          <label class="wide">Destination path<input bind:value={modelForm.dest} placeholder="releases/client" required /></label>
          <label class="wide">Description<textarea bind:value={modelForm.description} rows="2" placeholder="Optional release notes"></textarea></label>
          <fieldset class="wide"><legend>Platforms <span>(leave blank for all)</span></legend>{#each ['WINDOWS', 'MACOS', 'LINUX'] as os}<label class="check"><input type="checkbox" checked={modelForm.os.includes(os)} on:change={() => toggleOs(os)} />{os}</label>{/each}</fieldset>
          <button class="wide" disabled={busy}>Create model</button>
        </form>
      </section>

      <section class="card">
        <div class="card-heading"><div><p class="eyebrow">02</p><h2>Upload a file</h2></div></div>
        {#if models.length === 0}<p class="muted">Create a model before uploading a file.</p>{:else}
          <form on:submit|preventDefault={uploadFile} class="form-grid">
            <label class="wide">Model<select bind:value={upload.model} required><option value="">Choose a model</option>{#each models as model}<option value={model.name}>{model.name} · {model.version}{model.source === 'paladium' ? ' · Paladium' : ''}</option>{/each}</select></label>
            <label class="wide">Relative path <span>(optional)</span><input bind:value={upload.path} placeholder="mods/example.jar" /></label>
            <label class="wide file-picker">Select file<input id="file-input" type="file" required on:change={(event) => upload = { ...upload, file: event.target.files[0] }} /><small>{upload.file ? upload.file.name : 'No file selected'}</small></label>
            <button class="wide" disabled={busy}>Upload file</button>
          </form>
        {/if}
      </section>

      <section class="card">
        <div class="card-heading"><div><p class="eyebrow">03</p><h2>Upload a directory</h2></div></div>
        {#if models.length === 0}<p class="muted">Create a model before uploading a directory.</p>{:else}
          <form on:submit|preventDefault={uploadDirectory} class="form-grid">
            <label class="wide">Model<select bind:value={batchUpload.model} required><option value="">Choose a model</option>{#each models as model}<option value={model.name}>{model.name} · {model.version}{model.source === 'paladium' ? ' · Paladium' : ''}</option>{/each}</select></label>
            <label class="wide file-picker">Select directory<input id="directory-input" type="file" webkitdirectory directory required on:change={chooseDirectory} /><small>{directoryUploadProgress ? `Uploading ${directoryUploadProgress.completed} of ${directoryUploadProgress.total} files…` : batchUpload.files.length ? `${batchUpload.files.length} file${batchUpload.files.length === 1 ? '' : 's'} selected` : 'No directory selected'}</small></label>
            <p class="wide muted">Files are placed relative to the chosen directory. For example, <code>mods/fr/paladium/zephyr.jar</code> is uploaded as <code>fr/paladium/zephyr.jar</code> inside this model’s destination.</p>
            <button class="wide" disabled={busy}>Upload directory</button>
          </form>
        {/if}
      </section>

      <section class="card publish">
        <div class="card-heading"><div><p class="eyebrow">PUBLISHING</p><h2>Manifest sources</h2></div></div>
        <p class="muted">Your uploaded files are always included in <code>/manifest.json</code>.</p>
        <label class="switch"><input type="checkbox" bind:checked={config.exclude_paladium} on:change={updateConfig} disabled={busy} /><span></span><b>Exclude Paladium CDN files</b></label>
      </section>
    </div>

    <section class="card library"><div class="card-heading"><div><p class="eyebrow">LIBRARY</p><h2>Uploaded files</h2></div><span class="count">{files.length}</span></div>
      {#if files.length === 0}<div class="empty">No uploaded files yet.</div>{:else}
        <div class="file-library-controls">
          <label>Search by name<input type="search" bind:value={fileSearch} placeholder="example.jar" aria-label="Search uploaded files by name" /></label>
          <div class="model-filter"><span>Models</span><details><summary>{selectedFileModels.length === 0 ? 'All models' : selectedFileModels.length === 1 ? selectedFileModels[0] : `${selectedFileModels.length} models selected`}</summary><div class="model-options">{#each [...new Set(files.map((file) => file.model))].sort() as model}<label><input type="checkbox" checked={selectedFileModels.includes(model)} on:change={() => toggleFileModel(model)} /><span>{model}</span></label>{/each}</div></details></div>
          <label>Sort by<select bind:value={fileSort} aria-label="Sort uploaded files"><option value="name">Name</option><option value="size">Size</option><option value="model">Model</option></select></label>
        </div>
        {#if visibleFiles.length === 0}<div class="empty">No uploaded files match “{fileSearch}”.</div>{:else}<div class="table-wrap"><table><thead><tr><th>Name</th><th>Model</th><th>Path</th><th>Size</th><th></th></tr></thead><tbody>{#each visibleFiles as file}<tr><td><a href={file.url} target="_blank" rel="noreferrer">{file.name}</a></td><td>{file.model}</td><td><code>{file.path}</code></td><td>{size(file.size)}</td><td class="file-actions"><button class="secondary" on:click={() => document.querySelector(`#replace-${file.id}`).click()} disabled={busy}>Replace</button><input id={`replace-${file.id}`} class="visually-hidden" type="file" on:change={(event) => replaceFile(file, event)} /><button class="danger" on:click={() => removeFile(file)} disabled={busy}>Delete</button></td></tr>{/each}</tbody></table></div>{/if}
      {/if}
    </section>

    <section class="card library"><div class="card-heading"><div><p class="eyebrow">MODELS</p><h2>Model catalog</h2></div><span class="count">{models.length}</span></div>
      <p class="muted">Excluded models stay available here but are not published in the manifest.</p>
      {#if models.length === 0}<div class="empty">No models available yet.</div>{:else}<div class="table-wrap"><table><thead><tr><th>Model</th><th>Source</th><th>Destination</th><th>Platforms</th><th>Status</th><th></th></tr></thead><tbody>{#each models as model}<tr class:excluded={model.excluded}><td><strong>{model.name}</strong><small>{model.version}</small></td><td><span class:local={model.source === 'local'} class="source">{model.source === 'local' ? 'Local' : 'Paladium'}</span></td><td><code>{model.dest}</code></td><td>{model.os.length ? model.os.join(', ') : 'All'}</td><td><button class:include={model.excluded} class="status" on:click={() => setModelExcluded(model)} disabled={busy}>{model.excluded ? 'Excluded' : 'Included'}</button></td><td class="actions">{#if model.source === 'local'}<button class="secondary" on:click={() => startEditingModel(model)} disabled={busy}>Edit</button><button class="danger" on:click={() => deleteModel(model)} disabled={busy}>Delete</button>{/if}</td></tr>{/each}</tbody></table></div>{/if}
    </section>
  </main>
{/if}

{#if editingModel}
  <div class="modal-backdrop" role="presentation"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="edit-model-title"><div class="card-heading"><h2 id="edit-model-title">Edit {editingModel.name}</h2><button class="text-button" on:click={() => editingModel = null}>Cancel</button></div><form on:submit|preventDefault={saveModel} class="form-grid"><label>Version<input bind:value={editingModel.version} required /></label><label>Destination path<input bind:value={editingModel.dest} required /></label><label class="wide">Description<textarea bind:value={editingModel.description} rows="3"></textarea></label><fieldset class="wide"><legend>Platforms <span>(leave blank for all)</span></legend>{#each ['WINDOWS', 'MACOS', 'LINUX'] as os}<label class="check"><input type="checkbox" checked={editingModel.os.includes(os)} on:change={() => toggleEditingOs(os)} />{os}</label>{/each}</fieldset><button class="wide" disabled={busy}>Save changes</button></form></section></div>
{/if}
