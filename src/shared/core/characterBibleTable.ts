/** Shared, structured character editor for all generated review pages. Host owns Markdown serialization. */
export function characterBibleTableButton(locale: string): string {
  return `<button id="characterBibleToggle" type="button">${locale === "zh-CN" ? "角色圣经" : "Characters"}</button>`;
}

export function characterBibleTableHtml(locale: string): string {
  const zh = locale === "zh-CN";
  return `<style>
  .yn-character-dialog { width:min(1100px,95vw); max-height:90vh; border:1px solid #b6cce0; border-radius:12px; background:#f9fcff; color:#23354b; padding:20px; }
  .yn-character-dialog::backdrop { background:#152b4866; }
  .yn-character-dialog h2 { font-size:20px; margin:0; }
  .yn-character-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:12px 0; }
  .yn-character-dialog button,.yn-character-dialog input,.yn-character-dialog textarea,.yn-character-dialog select { font:inherit; color:inherit; border:1px solid #b6cce0; border-radius:6px; background:white; padding:7px 10px; min-height:34px; }
  .yn-character-dialog button { cursor:pointer; }
  .yn-character-dialog button:disabled { opacity:.5; cursor:wait; }
  .yn-character-status { min-height:1.5em; color:#6b4c17; white-space:pre-wrap; }
  .yn-character-table-scroll { overflow:auto; max-height:60vh; }
  .yn-character-dialog table { width:100%; border-collapse:collapse; table-layout:auto; font-size:14px; }
  .yn-character-dialog th,.yn-character-dialog td { text-align:left; padding:9px; border-bottom:1px solid #d7e3ee; max-width:300px; overflow-wrap:anywhere; vertical-align:top; white-space:pre-wrap; }
  .yn-character-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
  .yn-character-field { display:grid; gap:4px; font-size:14px; }
  .yn-character-field input,.yn-character-field textarea { width:100%; }
  .yn-character-mappings { grid-column:1/-1; }
  .yn-character-mapping { display:grid; grid-template-columns:minmax(0,1fr) 20px minmax(0,1fr) auto; gap:6px; align-items:center; margin:6px 0; }
  @media(max-width:650px) { .yn-character-fields { grid-template-columns:1fr; } .yn-character-dialog { padding:12px; } }
  </style>
  <dialog id="characterBibleDialog" class="yn-character-dialog" aria-labelledby="characterBibleTitle">
    <h2 id="characterBibleTitle">${zh ? "角色圣经" : "Character bible"}</h2>
    <p>${zh ? "按角色查看和编辑资料。填写表格后保存，YN 会自动整理成正确的角色表格式。" : "View and edit character details in the table. YN saves them in the correct character-bible format."}</p>
    <div class="yn-character-actions"><button id="characterBibleRefresh" type="button">${zh ? "刷新" : "Refresh"}</button><button id="characterBibleAdd" type="button">${zh ? "添加角色" : "Add character"}</button><button id="characterBibleClose" type="button">${zh ? "关闭" : "Close"}</button></div>
    <p id="characterBibleStatus" class="yn-character-status" role="status" aria-live="polite"></p>
    <div class="yn-character-table-scroll"><table><thead><tr>${(zh ? ["原文名", "译名", "别名", "性别 / 代词", "角色 / 口吻", "操作"] : ["Source name", "Localized name", "Aliases", "Gender / pronouns", "Role / voice", "Actions"]).map(label => `<th>${label}</th>`).join("")}</tr></thead><tbody id="characterBibleRows"></tbody></table></div>
  </dialog>
  <dialog id="characterBibleEditor" class="yn-character-dialog" aria-labelledby="characterBibleEditorTitle">
    <h2 id="characterBibleEditorTitle">${zh ? "编辑角色" : "Edit character"}</h2>
    <form id="characterBibleForm"><div id="characterBibleFields" class="yn-character-fields"></div><p id="characterBibleEditorStatus" class="yn-character-status" role="status" aria-live="polite"></p><div class="yn-character-actions"><button id="characterBibleSave" type="submit">${zh ? "保存" : "Save"}</button><button id="characterBibleCancel" type="button">${zh ? "取消" : "Cancel"}</button></div></form>
  </dialog>`;
}

export function characterBibleTableScript(): string {
  return String.raw`
(() => {
  const dataElement = document.getElementById("reviewData") || document.getElementById("proposalData") || document.getElementById("batchData");
  const page = JSON.parse(dataElement.textContent);
  const zh = (page.locale || document.documentElement.lang) === "zh-CN";
  const outputDir = page.workflow?.paths?.outputDir || page.outputDir || page.folderAgentRoute?.outputDir || "";
  const bridge = () => window.workshopHtml || window.parent?.workshopHtml || window.workshop;
  const text = (cn, en) => zh ? cn : en;
  const dialog = document.getElementById("characterBibleDialog");
  const editor = document.getElementById("characterBibleEditor");
  const rows = document.getElementById("characterBibleRows");
  const status = document.getElementById("characterBibleStatus");
  const editorStatus = document.getElementById("characterBibleEditorStatus");
  const fields = document.getElementById("characterBibleFields");
  let assets = null;
  let baseline = null;
  let revision = "";
  let busy = false;
  const definitions = [
    ["name","原文名","Source name"], ["target","译名","Localized name"],
    ["aliases","别名（每行一个）","Aliases (one per line)",true],
    ["gender","性别","Gender"], ["pronouns","代词","Pronouns"],
    ["genderConfidence","性别置信度","Gender confidence"],
    ["termsOfAddress","称呼方式","Terms of address"], ["voice","口吻","Voice"],
    ["identity","身份","Identity"], ["role","角色定位","Role"],
    ["relationships","人物关系","Relationships"], ["catchphrases","口头禅","Catchphrases"],
    ["forbiddenTerms","禁用词（每行一个）","Forbidden terms (one per line)",true],
    ["evidence","证据","Evidence"]
  ];
  function button(label, action) {
    const node = document.createElement("button"); node.type = "button"; node.textContent = label;
    node.addEventListener("click", action); return node;
  }
  function currentCharacters() { return assets?.characterBible?.characters || []; }
  function applyAssets(value) {
    if (!Array.isArray(value?.characterBible?.characters) || !value.characterBible.revisions) throw new Error(text("Host 未返回完整角色记录及版本。", "Host did not return complete character records and revisions."));
    assets = value; render();
  }
  function render() {
    rows.replaceChildren();
    for (const entry of currentCharacters()) {
      const tr = document.createElement("tr");
      for (const value of [entry.name, entry.target, (entry.aliases || []).join("\n"), [entry.gender,entry.pronouns].filter(Boolean).join(" / "), [entry.role,entry.voice].filter(Boolean).join("\n")]) {
        const td = document.createElement("td"); td.textContent = value || ""; tr.append(td);
      }
      const actions = document.createElement("td");
      actions.append(button(text("查看 / 编辑","View / edit"), () => openEditor(entry)), button(text("删除","Delete"), () => void remove(entry)));
      tr.append(actions); rows.append(tr);
    }
    if (!currentCharacters().length) status.textContent = text("尚无角色。可以添加角色或稍后刷新 Agent 发现的角色。", "No characters yet. Add a character or refresh after the Agent discovers one.");
  }
  function assertBridge(method) {
    if (!outputDir || !bridge()?.[method]) throw new Error(text("请在翻译工作台中打开关联项目的 HTML。", "Open this project HTML in translation-workshop."));
    return bridge();
  }
  async function refresh() {
    status.textContent = text("读取中…","Loading…");
    try { applyAssets(await assertBridge("readProjectAssets").readProjectAssets({outputDir})); if (currentCharacters().length) status.textContent = text("角色记录已更新。","Character records refreshed."); }
    catch (error) { status.textContent = error?.message || String(error); }
  }
  function mappingRow(source = "", target = "") {
    const row = document.createElement("div"); row.className = "yn-character-mapping";
    const from = document.createElement("input"); from.value = source; from.placeholder = text("台词中的原词","Source term in dialogue"); from.setAttribute("aria-label",from.placeholder);
    const arrow = document.createElement("span"); arrow.textContent = "→";
    const to = document.createElement("input"); to.value = target; to.placeholder = text("指定译法","Required translation"); to.setAttribute("aria-label",to.placeholder);
    row.append(from,arrow,to,button(text("移除","Remove"),() => row.remove())); return row;
  }
  function openEditor(entry) {
    if (busy) return;
    baseline = entry ? JSON.parse(JSON.stringify(entry)) : null;
    revision = entry ? assets.characterBible.revisions[entry.name] : "";
    fields.replaceChildren(); editorStatus.textContent = "";
    for (const [key,cn,en,list] of definitions) {
      const label = document.createElement("label"); label.className = "yn-character-field"; label.textContent = text(cn,en);
      let input;
      if (key === "genderConfidence") {
        input = document.createElement("select");
        for (const value of ["","unknown","inferred","confirmed"]) { const option = document.createElement("option"); option.value = value; option.textContent = ({unknown:text("未知","Unknown"),inferred:text("推断","Inferred"),confirmed:text("确认","Confirmed")})[value] || "—"; input.append(option); }
        // Keep a legacy value visible so saving another field cannot erase it.
        if (entry?.[key] && !Array.from(input.options).some(option => option.value === entry[key])) { const option = document.createElement("option"); option.value = entry[key]; option.textContent = entry[key]; input.append(option); }
      } else { input = document.createElement(list ? "textarea" : "input"); }
      input.dataset.characterField = key;
      input.value = list ? (entry?.[key] || []).join("\n") : entry?.[key] || "";
      if (key === "name") input.required = true;
      label.append(input); fields.append(label);
    }
    const mappings = document.createElement("section"); mappings.className = "yn-character-mappings";
    const title = document.createElement("p"); title.textContent = text("必用台词映射（原词 → 译法；角色名不属于台词映射）","Required dialogue mappings (source → translation; character names are not dialogue mappings)");
    const list = document.createElement("div"); list.id = "characterBibleMappings";
    for (const term of entry?.requiredTerms || []) {
      const match = term.match(/^(.+?)\s*(?:->|=>|→)\s*(.+)$/);
      list.append(mappingRow(match ? match[1].trim() : term,match ? match[2].trim() : ""));
    }
    mappings.append(title,list,button(text("添加映射","Add mapping"),() => list.append(mappingRow()))); fields.append(mappings);
    editor.showModal();
  }
  async function remove(entry) {
    if (busy || !confirm(text("从角色圣经删除「","Delete “") + entry.name + text("」？","” from the character bible?"))) return;
    busy = true; status.textContent = text("保存中…","Saving…");
    try { applyAssets(await assertBridge("mutateProjectCharacterBibleEntry").mutateProjectCharacterBibleEntry({outputDir,operation:"delete",name:entry.name,expectedRevision:assets.characterBible.revisions[entry.name]})); status.textContent = text("角色已删除。","Character deleted."); }
    catch (error) { status.textContent = error?.message || String(error); }
    finally { busy = false; }
  }
  document.getElementById("characterBibleForm").addEventListener("submit",async event => {
    event.preventDefault(); if (busy) return;
    const patch = {};
    try {
      for (const [key,,,list] of definitions) {
        const input = fields.querySelector('[data-character-field="' + key + '"]');
        const value = list ? input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : input.value.trim();
        const before = baseline?.[key] ?? (list ? [] : "");
        if (!baseline || JSON.stringify(value) !== JSON.stringify(before)) patch[key] = value;
      }
      const requiredTerms = Array.from(document.querySelectorAll("#characterBibleMappings .yn-character-mapping")).map(row => {
        const inputs = row.querySelectorAll("input"); const source = inputs[0].value.trim(); const target = inputs[1].value.trim();
        if (!source || !target) throw new Error(text("每条台词映射都必须填写原词和译法。","Each dialogue mapping requires both a source and a translation."));
        return source + " -> " + target;
      });
      if (!baseline || JSON.stringify(requiredTerms) !== JSON.stringify(baseline.requiredTerms || [])) patch.requiredTerms = requiredTerms;
      busy = true; document.getElementById("characterBibleSave").disabled = true; editorStatus.textContent = text("保存中…","Saving…");
      applyAssets(await assertBridge("mutateProjectCharacterBibleEntry").mutateProjectCharacterBibleEntry({outputDir,operation:baseline?"update":"add",name:baseline?.name,expectedRevision:revision,entry:patch}));
      editor.close(); status.textContent = text("角色已保存。","Character saved.");
    } catch (error) { editorStatus.textContent = error?.message || String(error); }
    finally { busy = false; document.getElementById("characterBibleSave").disabled = false; }
  });
  document.getElementById("characterBibleToggle").addEventListener("click",() => { dialog.showModal(); void refresh(); });
  document.getElementById("characterBibleRefresh").addEventListener("click",() => { if (!busy) void refresh(); });
  document.getElementById("characterBibleAdd").addEventListener("click",() => openEditor(null));
  document.getElementById("characterBibleClose").addEventListener("click",() => dialog.close());
  document.getElementById("characterBibleCancel").addEventListener("click",() => { if (!busy) editor.close(); });
  editor.addEventListener("cancel",event => { if (busy) event.preventDefault(); });
  const unsubscribe = bridge()?.onProjectAssetsUpdate?.(payload => {
    const normalized = value => String(value || "").replace(/\\/g,"/").replace(/\/+$/,"").toLocaleLowerCase();
    if (normalized(payload?.outputDir) !== normalized(outputDir) || !payload?.assets?.characterBible?.revisions) return;
    applyAssets(payload.assets);
  });
  window.addEventListener("beforeunload",() => unsubscribe?.(),{once:true});
})();`;
}
