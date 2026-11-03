import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_DIR = path.resolve(__dirname, '../src/client');

console.log('======================================================================');
console.log('  AniTAG Frontend JavaScript Syntax & Module Integrity Validator');
console.log('======================================================================\n');

let totalErrors = 0;

// Setup mock window/document for ES modules that access window
global.window = {
  location: { origin: 'http://localhost:4000', protocol: 'http:', hostname: 'localhost', host: 'localhost:4000' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {}
};
global.document = {
  getElementById: () => null,
  querySelectorAll: () => []
};
Object.defineProperty(global, 'navigator', {
  value: { userAgent: 'NodeTestBrowser' },
  configurable: true
});
global.WebSocket = class MockWebSocket {
  constructor() {
    this.readyState = 0;
  }
  close() {}
  send() {}
};

async function validate() {
  // 1. Validate modules in src/client/
  const moduleFiles = ['config.js', 'storage.js', 'supabase.js', 'sync.js'];
  for (const file of moduleFiles) {
    const filePath = path.join(CLIENT_DIR, file);
    if (!fs.existsSync(filePath)) {
      console.error(`[FAIL] Missing expected module file: ${file}`);
      totalErrors++;
      continue;
    }
    try {
      await import(`file://${filePath}?t=${Date.now()}`);
      console.log(`[PASS] Module ${file}: Syntax valid`);
    } catch (err) {
      console.error(`[FAIL] Module ${file} SYNTAX ERROR: ${err.message}`);
      totalErrors++;
    }
  }

  // 2. Validate embedded scripts in src/client/index.html
  const htmlPath = path.join(CLIENT_DIR, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  // Match all inline <script> tags (without src attribute)
  const scriptRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let scriptIndex = 0;

  while ((match = scriptRegex.exec(html)) !== null) {
    scriptIndex++;
    const scriptContent = match[1];
    if (!scriptContent.trim()) continue;

    // Calculate starting line number in index.html
    const prefix = html.substring(0, match.index);
    const startLine = prefix.split('\n').length;

    console.log(`\nValidating embedded script #${scriptIndex} (starting at index.html line ${startLine})...`);

    try {
      new vm.Script(scriptContent, { filename: `index.html(line ${startLine})` });
      console.log(`[PASS] Embedded script #${scriptIndex} at line ${startLine}: Syntax valid!`);
    } catch (err) {
      totalErrors++;
      console.error(`[FAIL] Embedded script #${scriptIndex} at line ${startLine} ERROR:`, err.message);
      const stackMatch = err.stack.match(/line (\d+)\):(\d+)/);
      if (stackMatch) {
        const scriptLineNum = parseInt(stackMatch[2], 10);
        const actualHtmlLineNum = startLine + scriptLineNum - 1;
        console.error(`  --> Actual index.html line: ${actualHtmlLineNum}`);
        const lines = scriptContent.split('\n');
        console.error('  Context:');
        for (let i = Math.max(0, scriptLineNum - 4); i < Math.min(lines.length, scriptLineNum + 3); i++) {
          const marker = (i + 1 === scriptLineNum) ? '>> ' : '   ';
          console.error(`${marker}Line ${startLine + i}: ${lines[i]}`);
        }
      }
    }
  }

  console.log('\n======================================================================');
  if (totalErrors === 0) {
    console.log('  ALL FRONTEND SCRIPTS AND MODULES ARE SYNTACTICALLY VALID (0 ERRORS)');
    console.log('======================================================================\n');
    process.exit(0);
  } else {
    console.error(`  VALIDATION FAILED WITH ${totalErrors} SYNTAX ERROR(S)`);
    console.log('======================================================================\n');
    process.exit(1);
  }
}

validate();
