/**
 * align-trim-suite.mjs —— 片段裁剪规则的测试
 *
 * 全是**实测踩到的真例**（都出自 18 句串台测试），不是编的：
 * 吞掉整句的、只取第一个词的、夹带隔壁实体名的、以及该拒答的描述性短语。
 */

import { canonicalWords, normalizeToken, shapeSimilarity, trimSpan } from '../lib/align-trim.mjs'

export async function runAlignTrimSuite({ it, check, assert }) {
  const tok = text => text.split(' ')

  await it('吞掉整句 → 裁回单个名字（×17 的那条）', () => {
    const tokens = tok('Xiaomi e a Lenovo têm centros de pesquisa e desenvolvimento em Shenzhen , e são bem grandes .')
    const result = trimSpan({ tokens, start: 0, end: tokens.length - 1, canonical: 'Xiaomi' })
    check('裁出了片段', result !== null)
    check('结果就是 Xiaomi', result.text === 'Xiaomi', result.text)
  })

  await it('后半句被吞进来 → 裁掉（O Alibaba abriu … no Rio）', () => {
    const tokens = tok('O Alibaba abriu um escritório no Rio')
    const result = trimSpan({ tokens, start: 0, end: tokens.length - 1, canonical: 'Alibaba' })
    check('结果就是 Alibaba（剥掉冠词与后面的动词短语）', result.text === 'Alibaba', result.text)
  })

  await it('夹带隔壁实体 → 只留自己（CATL e a SMIC）', () => {
    const tokens = tok('CATL e a SMIC')
    const result = trimSpan({ tokens, start: 0, end: tokens.length - 1, canonical: 'SMIC' })
    check('结果就是 SMIC', result.text === 'SMIC', result.text)
  })

  await it('只拿到第一个词 → 向后补齐型号（Kirin → Kirin 9000s）', () => {
    const tokens = tok('O Huawei Mate 60 Pro usa o chip Kirin 9000s , isso é muito discutido .')
    const start = tokens.indexOf('Kirin')
    const result = trimSpan({ tokens, start, end: start, canonical: 'Kirin 9000s' })
    check('补成完整型号', result.text === 'Kirin 9000s', result.text)
  })

  await it('向后补齐带数字的型号（Snapdragon → Snapdragon 8 Gen 3）', () => {
    const tokens = tok('Este celular usa o Snapdragon 8 Gen 3 , não o Kirin 9000s .')
    const start = tokens.indexOf('Snapdragon')
    const result = trimSpan({ tokens, start, end: start, canonical: 'Snapdragon 8 Gen 3' })
    check('三个词全补齐', result.text === 'Snapdragon 8 Gen 3', result.text)
  })

  await it('补齐时**不许**吞进相邻的别的名字（Musk 前面是 Zhang Yiming）', () => {
    const tokens = tok('Zhang Yiming e Musk participaram do mesmo fórum .')
    const start = tokens.indexOf('Musk')
    const result = trimSpan({ tokens, start, end: start, canonical: 'Elon Musk' })
    check('不会把 Zhang Yiming 吞进来', result.text === 'Musk', result.text)
  })

  await it('描述性短语 → 拒答（工信部 → Ministério da Indústria e Informação）', () => {
    const tokens = tok('Musk se reuniu com os funcionários do Ministério da Indústria e Informação durante a visita .')
    const start = tokens.indexOf('Ministério')
    const result = trimSpan({ tokens, start, end: tokens.indexOf('Informação'), canonical: 'MIIT' })
    check('拒答（返回 null），而不是给一个会毁句子的片段', result === null, JSON.stringify(result))
  })

  await it('已经是干净的单名 → 原样返回', () => {
    const tokens = tok('A Huawei e a BYD estão em Shenzhen .')
    const start = tokens.indexOf('Huawei')
    const result = trimSpan({ tokens, start, end: start, canonical: 'Huawei' })
    check('不变', result.text === 'Huawei', result.text)
  })

  await it('片段两端是标点时也会剥掉', () => {
    const tokens = tok('Lenovo , Baidu e Tencent participaram .')
    const result = trimSpan({ tokens, start: 0, end: 1, canonical: 'Lenovo' })
    check('剥掉逗号', result.text === 'Lenovo', result.text)
  })

  await it('纯函数层面：归一与相似度可用（不是靠巧合）', () => {
    check('归一去掉标点', normalizeToken('Pro,') === 'pro')
    check('规范写法切成词', canonicalWords('Snapdragon 8 Gen 3').length === 4)
    check('完全一致相似度为 1', shapeSimilarity(['Kirin', '9000s'], 'Kirin 9000s') === 1)
    check('毫不相干相似度接近 0', shapeSimilarity(['Beijing'], 'Pequim') < 0.2)
  })
}
