/**
 * OpenCode HTTP 请求助手 (CommonJS) - 流式版本
 * 解决 ESM 模块无法正确读取 Hono streaming 响应的问题
 * 
 * 用法: node opencode-http-helper.js <url> <body_file_path> <timeout_ms> [stream]
 *   stream=0: 非流式（默认，等完整响应后输出 JSON）
 *   stream=1: 流式模式（逐 data 块输出，格式: DATA:<json>\n）
 * 输出（非流式）: JSON 格式的 { status, body }
 * 输出（流式）: 多行 DATA:<chunk_json> + 最后 EVENT:end\n
 */
const http = require('http');
const fs = require('fs');

const url = process.argv[2];
const bodyFile = process.argv[3];
const timeout = parseInt(process.argv[4]) || 300000;
const useStream = process.argv[5] === '1';

if (!url || !bodyFile) {
  console.error(JSON.stringify({ error: 'Missing arguments' }));
  process.exit(1);
}

let body;
try {
  body = fs.readFileSync(bodyFile, 'utf-8');
} catch (e) {
  console.error(JSON.stringify({ error: `读取body文件失败: ${e.message}` }));
  process.exit(1);
}

const parsedUrl = new URL(url);

const options = {
  hostname: parsedUrl.hostname,
  port: parsedUrl.port || 80,
  path: parsedUrl.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  },
  timeout: timeout
};

if (useStream) {
  const req = http.request(options, (res) => {
    console.log(`STATUS:${res.statusCode}`);
    
    let totalSize = 0;
    
    res.on('data', (chunk) => {
      totalSize += chunk.length;
      const chunkStr = chunk.toString('utf-8');
      console.log(`DATA:${JSON.stringify({ chunk: chunkStr, size: chunk.length, total: totalSize })}`);
    });
    
    res.on('end', () => {
      console.log(`EVENT:end`);
    });
    
    res.on('error', (e) => {
      console.error(`ERROR:${JSON.stringify({ error: e.message })}`);
    });
  });

  req.on('error', (e) => {
    console.error(`ERROR:${JSON.stringify({ error: e.message })}`);
  });

  req.on('timeout', () => {
    req.destroy();
    console.error(`ERROR:${JSON.stringify({ error: 'timeout' })}`);
  });

  req.write(body);
  req.end();
} else {
  const req = http.request(options, (res) => {
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      console.log(JSON.stringify({ status: res.statusCode, body: data }));
    });
    
    res.on('error', (e) => {
      console.error(JSON.stringify({ error: e.message }));
    });
  });

  req.on('error', (e) => {
    console.error(JSON.stringify({ error: e.message }));
  });

  req.on('timeout', () => {
    req.destroy();
    console.error(JSON.stringify({ error: 'timeout' }));
  });

  req.write(body);
  req.end();
}
