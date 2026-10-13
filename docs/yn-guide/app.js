(() => {
  const data = window.YN_GUIDE;
  if (!data || data.schemaVersion !== 4 || data.version !== document.body.dataset.version || !Array.isArray(data.pages)) throw new Error('Guide metadata does not match the document version.');
  const locale = document.body.dataset.locale, en = locale === 'en';
  const file = decodeURIComponent(location.pathname.split('/').pop() || 'index.html');
  if (!data.pages.some(page => page.file === file)) throw new Error('Guide page is missing from the index: ' + file);
  const requested = new URLSearchParams(location.search).get('lang');
  if ((requested === 'en' || requested === 'zh') && requested !== locale) {
    const target = new URL(location.href);
    target.pathname = target.pathname.replace(/(?:\.en)?\.html$/, requested === 'en' ? '.en.html' : '.html');
    if (!target.pathname.endsWith('.html')) target.pathname += requested === 'en' ? 'index.en.html' : 'index.html';
    target.searchParams.delete('lang'); location.replace(target); return;
  }
  const dialog = document.getElementById('search-dialog'), input = document.getElementById('global-search'), results = document.getElementById('search-results');
  const search = () => {
    const query = input.value.trim().toLocaleLowerCase();
    const pages = data.pages.filter(page => page.locale === locale && (!query || (page.title + ' ' + page.summary).toLocaleLowerCase().includes(query)))
      .sort((a, b) => Number(b.title.toLocaleLowerCase().includes(query)) - Number(a.title.toLocaleLowerCase().includes(query)));
    results.replaceChildren();
    for (const page of pages) {
      const link = document.createElement('a'); link.className = 'search-result'; link.href = page.file;
      const title = document.createElement('strong'); title.textContent = page.title; link.append(title);
      const details = document.createElement('p'); details.textContent = page.summary.slice(0, 180); link.append(details); results.append(link);
    }
    if (!pages.length) { const message = document.createElement('p'); message.textContent = en ? 'No matching topic.' : '没有匹配主题。'; results.append(message); }
  };
  const openSearch = () => { dialog.showModal(); search(); input.focus(); };
  document.querySelector('[data-search-open]').addEventListener('click', openSearch);
  document.querySelector('[data-search-close]').addEventListener('click', () => dialog.close());
  input.addEventListener('input', search);
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!dialog.open) openSearch(); } });
  document.querySelector('[data-menu]').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  document.querySelector('.sidebar').addEventListener('click', event => { if (event.target.closest('a')) document.body.classList.remove('nav-open'); });
  const lightbox = document.getElementById('lightbox');
  for (const image of document.querySelectorAll('.content img')) {
    if (!image.getAttribute('src')?.startsWith('assets/screens/')) continue;
    image.tabIndex = 0; image.classList.add('zoomable');
    const show = () => { const enlarged = lightbox.querySelector('img'); enlarged.src = image.src; enlarged.alt = image.alt; lightbox.showModal(); };
    image.addEventListener('click', show); image.addEventListener('keydown', event => { if (event.key === 'Enter') show(); });
  }
  document.querySelector('[data-lightbox-close]').addEventListener('click', () => lightbox.close());
  // Old local copy is retained without overriding the new Markdown publication.
  if (location.protocol !== 'file:' && !['localhost', '127.0.0.1'].includes(location.hostname)) return;
  const key = 'yn-guide-static-copy-v4';
  const readEdits = () => { const saved = JSON.parse(localStorage.getItem(key) || '{}'); if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid local guide copy storage.'); return saved; };
  const edits = readEdits(), editor = document.createElement('div'); editor.className = 'copy-editor-bar';
  const status = document.createElement('span'); status.textContent = en ? 'Local copy; Markdown is the publication source.' : '本地文案编辑；发布正文以 Markdown 为准。'; editor.append(status);
  let editing = false;
  const nodes = [...document.querySelectorAll('.content p, .content h1, .content h2, .content h3, .content li')].filter(node => !node.querySelector('a, code, img, ul, ol'));
  const originals = nodes.map(node => node.textContent), ids = nodes.map((node, index) => file + ':' + index + ':' + originals[index]);
  nodes.forEach((node, index) => {
    if (typeof edits[ids[index]] === 'string') node.textContent = edits[ids[index]];
    node.addEventListener('input', () => { edits[ids[index]] = node.textContent; localStorage.setItem(key, JSON.stringify(edits)); });
  });
  const button = (label, action) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.addEventListener('click', action); editor.append(node); return node; };
  const toggle = button(en ? 'Edit text' : '编辑文字', () => {
    editing = !editing; nodes.forEach(node => { node.contentEditable = editing ? 'plaintext-only' : 'false'; });
    toggle.textContent = editing ? (en ? 'Done' : '完成') : (en ? 'Edit text' : '编辑文字'); document.body.classList.toggle('copy-editing', editing);
  });
  button(en ? 'Export all edits' : '导出全部修改', () => {
    const payload = { version: 4, edits: readEdits(), retainedLegacyEdits: localStorage.getItem('yn-guide-copy-edits-v2') };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'yn-guide-copy-edits-v4.json'; link.click(); URL.revokeObjectURL(url);
  });
  button(en ? 'Reset this page' : '重置当前页', () => { nodes.forEach((node, index) => { delete edits[ids[index]]; node.textContent = originals[index]; }); localStorage.setItem(key, JSON.stringify(edits)); });
  const picker = document.createElement('input'); picker.type = 'file'; picker.accept = '.json'; picker.hidden = true;
  picker.addEventListener('change', async () => {
    try {
      if (!picker.files?.[0]) return;
      const payload = JSON.parse(await picker.files[0].text());
      if (payload.version !== 4 || !payload.edits || typeof payload.edits !== 'object' || Array.isArray(payload.edits) || Object.values(payload.edits).some(value => typeof value !== 'string')) throw new Error('Import requires v4 guide edits with text values.');
      localStorage.setItem(key, JSON.stringify(payload.edits)); location.reload();
    } catch (error) { status.textContent = error.message; console.error(error); }
  }); editor.append(picker); button(en ? 'Import edits' : '导入修改', () => picker.click()); document.body.append(editor);
})();
