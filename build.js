const fs = require('fs');
const path = require('path');

const master = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/app_master_data.json'), 'utf8'));
const css = fs.readFileSync(path.join(__dirname, 'app_style.css'), 'utf8');
const logicTemplate = fs.readFileSync(path.join(__dirname, 'app_logic.js'), 'utf8');

// splice the CSS in as a JS constant + injector, right after the APP_SCRIPT_SOURCE capture line,
// so it is captured as part of APP_SCRIPT_SOURCE (the quine) automatically.
const CSS_MARKER = "const APP_SCRIPT_SOURCE = document.currentScript.textContent;";
const idx = logicTemplate.indexOf(CSS_MARKER);
if(idx === -1){ throw new Error('marker not found in app_logic.js'); }
const cssInject = "\nconst CSS_TEXT = `" + css.replace(/\\/g, '\\\\') + "`;\n" +
  "(function(){ const s = document.createElement('style'); s.textContent = CSS_TEXT; document.head.appendChild(s); })();\n";
const logic = logicTemplate.slice(0, idx + CSS_MARKER.length) + cssInject + logicTemplate.slice(idx + CSS_MARKER.length);

const initialState = {
  retail: { groupOrder: master.groupOrder.slice(), weeks: {}, months: {}, memoLog: [], campaigns: {} },
  wholesale: { groupOrder: (master.wholesaleGroupOrder || []).slice(), weeks: {}, months: {}, memoLog: [] },
};

function escLt(s){ return s.replace(/</g, '\\u003c'); }

const masterJson = escLt(JSON.stringify(master));
const stateJson = escLt(JSON.stringify(initialState));

const html = '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>紀の里 製造予定</title>\n</head>\n<body>\n' +
  '<div id="root"></div>\n<div class="toast" id="toast"></div>\n' +
  '<script id="app-master" type="application/json">' + masterJson + '<' + '/script>\n' +
  '<script id="app-state" type="application/json">' + stateJson + '<' + '/script>\n' +
  '<script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"><' + '/script>\n' +
  '<script>' + logic + '<' + '/script>\n' +
  '</body>\n</html>';

const outDir = path.join(__dirname, 'public');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), html);
console.log('written, length', html.length);
