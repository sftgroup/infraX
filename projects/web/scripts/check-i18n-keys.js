// 交叉校验：modules 中 I18N.t('key') 引用的键是否都存在于 i18n.js 字典
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'modules');

// 加载 i18n.js 获取 I18N.zh / I18N.en（在沙箱 vm 中执行）
const vm = require('vm');
const src = fs.readFileSync(path.join(dir, 'i18n.js'), 'utf8');
const sandbox = { localStorage: { getItem: () => 'zh', setItem: () => {} }, window: {}, document: { addEventListener: () => {}, querySelectorAll: () => [], documentElement: { lang: '', setAttribute: () => {}, getAttribute: () => null } }, I18N: {} };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const zh = sandbox.window.I18N.zh;
const en = sandbox.window.I18N.en;

let missing = [];
const keyRe = /I18N\.t\(\s*'([^']+)'\s*\)/g;
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.js') || f === 'i18n.js') continue;
  const code = fs.readFileSync(path.join(dir, f), 'utf8');
  let m;
  while ((m = keyRe.exec(code))) {
    const k = m[1];
    if (zh[k] === undefined) missing.push(f + ' -> ' + k + ' (zh missing)');
    else if (en[k] === undefined) missing.push(f + ' -> ' + k + ' (en missing)');
  }
}
if (missing.length) {
  console.log('MISSING KEYS:');
  missing.forEach((x) => console.log('  ' + x));
  process.exit(1);
}
console.log('All I18N.t() keys present in zh (' + Object.keys(zh).length + ') and en (' + Object.keys(en).length + ').');
