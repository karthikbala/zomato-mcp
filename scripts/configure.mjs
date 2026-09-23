import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { token } from '../src/security.js';

const ask = createInterface({ input: stdin, output: stdout });
try {
  const origin = (await ask.question('HTTPS origin (https://zomato.example.com): '))
    .trim()
    .replace(/\/$/, '');
  const mobile = (await ask.question('Zomato partner login mobile (10 digits): ')).trim();
  const restaurantId = (await ask.question('Exact Zomato restaurant ID: ')).trim();
  const outletName = (await ask.question('Exact outlet name displayed in Partner: ')).trim();
  if (
    !/^https:\/\/[^/]+$/.test(origin) ||
    !/^\d{10}$/.test(mobile) ||
    !/^\d{6,15}$/.test(restaurantId) ||
    !outletName
  )
    throw Error('Invalid origin, mobile, restaurant ID or outlet name.');
  for (const file of ['.env', '.secrets/connection.json', '.secrets/owner-access.txt']) {
    try {
      await access(file);
      throw Error(
        `${file} already exists. Keep the existing private configuration or remove it first.`,
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const mcpToken = token();
  const ownerKey = token();
  await mkdir('.secrets', { recursive: true, mode: 0o700 });
  await mkdir('data', { recursive: true, mode: 0o700 });
  const env =
    [
      'PORT=9320',
      'DATA_DIR=./data',
      `PUBLIC_ORIGIN=${origin}`,
      `ZOMATO_MOBILE=${mobile}`,
      `ZOMATO_RESTAURANT_ID=${restaurantId}`,
      `ZOMATO_OUTLET_NAME=${outletName}`,
      `MCP_TOKEN=${mcpToken}`,
      `OWNER_KEY=${ownerKey}`,
    ].join('\n') + '\n';
  await writeFile('.env', env, { flag: 'wx', mode: 0o600 });
  await writeFile(
    '.secrets/connection.json',
    JSON.stringify(
      {
        mcpServers: {
          zomato: {
            url: `${origin}/mcp`,
            headers: { Authorization: `Bearer ${mcpToken}` },
          },
        },
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(
    '.secrets/owner-access.txt',
    `Owner page: ${origin}/owner\nOwner key: ${ownerKey}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Private configuration written. Do not commit or share these files.');
} finally {
  ask.close();
}
