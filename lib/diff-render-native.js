/**
 * Browser-free diff image rendering (satori + resvg)
 *
 * Renders the diff model from lib/compare-diff.js buildDiffModel() to a
 * PNG without Chromium: satori lays out a flexbox element tree as SVG,
 * resvg rasterizes it. This is what makes the bot deployable on hosts
 * where a browser is impractical (e.g. Toolforge build-service images).
 *
 * Fonts: latin Noto Sans subsets are bundled (lib/fonts/). CJK coverage
 * is fetched once at runtime from the Fontsource CDN and cached under
 * data/fonts/ - if that fetch fails, rendering proceeds without CJK
 * glyphs (caller can fall back to the browser path).
 *
 * Styling mirrors renderDiffHtml's CSS so both paths produce the same
 * look.
 */

const fs = require('fs')
const path = require('path')
const satori = require('satori').default
const { Resvg } = require('@resvg/resvg-js')

const WIDTH = 1000
const FONT_DIR = path.join(__dirname, 'fonts')
const CJK_CACHE_DIR = path.join(__dirname, '..', 'data', 'fonts')
const CJK_FONT_URL = 'https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-kr@latest/korean-400-normal.ttf'
const CJK_RE = /[ᄀ-ᇿ　-鿿가-힯豈-﫿]/

// Palette copied from renderDiffHtml's CSS
const C = {
  text: '#202122',
  muted: '#54595d',
  faint: '#72777d',
  border: '#c8ccd1',
  addBg: '#d8ecd8',
  addGutter: '#14866d',
  delBg: '#fbdfdf',
  delGutter: '#d73333',
  ins: '#a3d3ff',
  del: '#ffb3b3'
}

let fontCache = null

function loadBundledFonts() {
  return [
    { name: 'Noto Sans', weight: 400, style: 'normal', data: fs.readFileSync(path.join(FONT_DIR, 'NotoSans-Regular.ttf')) },
    { name: 'Noto Sans', weight: 600, style: 'normal', data: fs.readFileSync(path.join(FONT_DIR, 'NotoSans-SemiBold.ttf')) },
    { name: 'Noto Sans', weight: 700, style: 'normal', data: fs.readFileSync(path.join(FONT_DIR, 'NotoSans-Bold.ttf')) }
  ]
}

/**
 * Fetch-and-cache the CJK font. Fail-soft: returns null on any problem.
 */
async function loadCjkFont() {
  const cached = path.join(CJK_CACHE_DIR, 'NotoSansKR-Regular.ttf')
  try {
    if (!fs.existsSync(cached)) {
      const res = await fetch(CJK_FONT_URL, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      fs.mkdirSync(CJK_CACHE_DIR, { recursive: true })
      fs.writeFileSync(cached, buf)
    }
    return { name: 'Noto Sans', weight: 400, style: 'normal', data: fs.readFileSync(cached) }
  } catch (e) {
    console.error('[diff-render-native] CJK font unavailable:', e.message)
    return null
  }
}

async function getFonts(needsCjk) {
  if (!fontCache) fontCache = loadBundledFonts()
  const fonts = [...fontCache]
  if (needsCjk) {
    const cjk = await loadCjkFont()
    if (cjk) fonts.push(cjk)
  }
  return fonts
}

// Shorthand for satori element nodes
function el(type, style, children) {
  return { type, props: { style, children } }
}

/**
 * Split segments into word-level tokens. Satori lays out each styled
 * span as a flex item, so a multi-word span would wrap as a block and
 * break the paragraph flow around highlights; word tokens flow like
 * normal text under flexWrap.
 */
function tokenize(segments) {
  const tokens = []
  for (const seg of segments) {
    for (const part of seg.text.match(/\S+\s*|\s+/g) || []) {
      tokens.push({ text: part, highlight: seg.highlight })
    }
  }
  return tokens
}

function textSpan(seg) {
  const style = { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
  if (seg.highlight === 'add') style.backgroundColor = C.ins
  if (seg.highlight === 'delete') {
    style.backgroundColor = C.del
    style.textDecoration = 'line-through'
  }
  return el('span', style, seg.text)
}

function buildRow(row) {
  const rowStyle = { display: 'flex', flexDirection: 'row', padding: '2px 0', width: '100%' }
  const gutterStyle = {
    width: 26,
    flexShrink: 0,
    justifyContent: 'center',
    fontWeight: 700,
    color: { add: C.addGutter, delete: C.delGutter }[row.kind] || C.faint
  }
  const textStyle = {
    flexGrow: 1,
    flexShrink: 1,
    display: 'flex',
    flexWrap: 'wrap',
    minWidth: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: C.text
  }

  if (row.kind === 'add') textStyle.backgroundColor = C.addBg
  if (row.kind === 'delete') {
    textStyle.backgroundColor = C.delBg
    textStyle.textDecoration = 'line-through'
  }
  if (row.kind === 'context') textStyle.color = C.muted
  if (row.kind === 'gap' || row.kind === 'footer') {
    textStyle.color = C.faint
    textStyle.justifyContent = 'center'
  }

  return el('div', rowStyle, [
    el('div', gutterStyle, row.gutter || ' '),
    el('div', textStyle, tokenize(row.segments).map(textSpan))
  ])
}

function buildHeader(model) {
  const heading = el('div', { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }, [
    el('div', {
      fontSize: 12, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase',
      color: C.faint, marginBottom: 2
    }, 'WIKIPEDIA EDIT'),
    el('div', { fontSize: 22, fontWeight: 600, color: C.text }, model.page),
    ...(model.description
      ? [el('div', { fontSize: 15, color: C.muted, marginTop: 3 }, model.description)]
      : [])
  ])

  const children = [heading]
  if (model.imageDataUri) {
    children.push({
      type: 'img',
      props: {
        src: model.imageDataUri,
        width: 76,
        height: 76,
        style: {
          borderRadius: 8,
          border: `1px solid ${C.border}`,
          objectFit: 'cover',
          flexShrink: 0
        }
      }
    })
  }

  return el('div', {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingBottom: 12,
    marginBottom: 14,
    borderBottom: `1px solid ${C.border}`,
    width: '100%'
  }, children)
}

/**
 * Render the diff model to a PNG buffer. Throws on failure - callers
 * (lib/diff-image.js) fall back to the browser path.
 * @param {Object} model - From buildDiffModel()
 * @returns {Promise<Buffer>} PNG bytes
 */
async function renderDiffModelPng(model) {
  const allText = model.page + (model.description || '') +
    model.rows.map(r => r.segments.map(s => s.text).join('')).join('')
  const fonts = await getFonts(CJK_RE.test(allText))

  const root = el('div', {
    display: 'flex',
    flexDirection: 'column',
    width: WIDTH,
    padding: '20px 24px',
    backgroundColor: '#ffffff',
    fontFamily: 'Noto Sans',
    fontSize: 17,
    lineHeight: 1.45,
    color: C.text
  }, [buildHeader(model), ...model.rows.map(buildRow)])

  const svg = await satori(root, { width: WIDTH, fonts })
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng()
  return Buffer.from(png)
}

/**
 * Render the model and write it to a screenshot-style temp file, matching
 * the interface of lib/screenshot.js (returns a file path).
 */
async function renderDiffModelToFile(model) {
  const png = await renderDiffModelPng(model)
  const filename = path.resolve(Date.now() + '.png')
  fs.writeFileSync(filename, png)
  return filename
}

module.exports = { renderDiffModelPng, renderDiffModelToFile }
