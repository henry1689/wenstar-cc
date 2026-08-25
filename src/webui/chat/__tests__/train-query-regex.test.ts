import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatSource = readFileSync(new URL('../../chat.ts', import.meta.url), 'utf8');
const stationSource = chatSource.match(/const _stSrc = '([^']+)'/)?.[1];
const routeExpression = "new RegExp('(?:从|由)?\\\\s*(' + _stSrc + ')\\\\s*(?:到|去|至|前往|回)\\\\s*(' + _stSrc + ')')";

describe('火车查询站名正则', () => {
  it('chat.ts 的两条查询路径都保留字符串正则所需的双反斜杠', () => {
    expect(stationSource).toBeTruthy();
    expect(chatSource.split(routeExpression).length - 1).toBe(2);
  });

  it.each([
    ['深圳到广州南的高铁几点？', '深圳', '广州南'],
    ['从 深圳 到 广州南 的班次', '深圳', '广州南'],
    ['北京 至 上海，今天有哪些车次？', '北京', '上海'],
    ['由福田前往香港？', '福田', '香港'],
  ])('匹配有无空格和中英文标点：%s', (message, from, to) => {
    const routePattern = new RegExp(
      '(?:从|由)?\\s*(' + stationSource + ')\\s*(?:到|去|至|前往|回)\\s*(' + stationSource + ')',
    );
    const match = message.match(routePattern);

    expect(match?.[1]).toBe(from);
    expect(match?.[2]).toBe(to);
  });
});
