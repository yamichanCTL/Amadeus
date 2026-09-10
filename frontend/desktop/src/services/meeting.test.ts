// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { MeetingTimeline, DEFAULT_MEETING_PREFERENCES, MEETING_PREFERENCES_KEY, readMeetingPreferences, meetingKeyword } from './meeting'

it.each([
  '解释一下，刚才这句话。',
  '解释 一下：刚才这句话！',
  '解释\t一下\n刚才这句话',
  '解释\u200b一下\uFEFF刚才这句话',
])('matches ASR formatting variations without changing the excerpt: %s', (spoken) => {
  expect(meetingKeyword(`前文。这里用Ｃ＋＋和😀。${spoken}`, '解释一下刚才这句话')).toMatchObject({
    count: 1, excerpt: { target: '这里用Ｃ＋＋和😀。', preceding: '前文。' },
  })
})

it('normalizes the configured command as well as ASR text', () => {
  expect(meetingKeyword('Use a quorum. Explain, THIS!', 'Ｅｘｐｌａｉｎ　ｔｈｉｓ！')).toMatchObject({
    count: 1, excerpt: { target: 'Use a quorum.', preceding: '' },
  })
})

it('maps expanded and composed Unicode characters back to the original text', () => {
  expect(meetingKeyword('原话①😀。ＯﬃＣＥ，ＣＡＦＥ\u0301！', 'office café')?.excerpt.target).toBe('原话①😀。')
})

it('counts commands consistently across formatting revisions and excludes earlier commands', () => {
  for (const first of ['解释一下，刚才这句话', '解释一下刚才这句话']) {
    expect(meetingKeyword(`第一句。${first}。前文。第二句。解释 一下：刚才这句话！后文。`, '解释一下刚才这句话')).toMatchObject({
      count: 2, excerpt: { target: '第二句。', preceding: `第一句。${first}。前文。` },
    })
  }
})

it.each(['', '  ', '，。！？', '\u200b\uFEFF'])('ignores empty normalized commands: %s', (keyword) => {
  expect(meetingKeyword('这里有会议原文。', keyword)).toBeNull()
})

it('does not treat commands as regex or match English words inside longer words', () => {
  expect(meetingKeyword('A target. explain thisway', 'explain this')).toBeNull()
  expect(meetingKeyword('A target. preexplain this', 'explain this')).toBeNull()
  expect(meetingKeyword('A target. explain anything this', 'explain.*this')).toBeNull()
  expect(meetingKeyword('A target. Explain, this!', 'explain this')?.count).toBe(1)
})


it('preserves old arrival times across ASR correction and bounds a rolling window', () => {
  const timeline = new MeetingTimeline()
  timeline.update('过去谈到洛管锁。', 1000)
  timeline.update('过去谈到乐观锁。', 2000)
  timeline.update('过去谈到乐观锁。最新概念。', 100000)
  const excerpt = timeline.excerpt(100000, { ...DEFAULT_MEETING_PREFERENCES, lookbackSeconds: 60, recentSeconds: 10 })
  expect(excerpt).toMatchObject({ target: '最新概念。', preceding: '过去谈到乐观锁。', recent: '最新概念。' })
  expect(timeline.excerpt(200000, { ...DEFAULT_MEETING_PREFERENCES, lookbackSeconds: 60 }).target).toBe('')
})

it('strips earlier spoken commands from later summaries and never includes post-trigger text', () => {
  const timeline = new MeetingTimeline()
  const text = '第一点。解释一下刚才这句话。第二点。解释一下，刚才这句话！未来内容。'
  timeline.update(text, 1000)
  const found = meetingKeyword(text, DEFAULT_MEETING_PREFERENCES.keyword)!
  const excerpt = timeline.excerpt(1000, DEFAULT_MEETING_PREFERENCES, found.start, DEFAULT_MEETING_PREFERENCES.keyword)
  expect(excerpt.target).toContain('第一点')
  expect(excerpt.target).toContain('第二点')
  expect(excerpt.target).not.toContain('解释一下')
  expect(excerpt.target).not.toContain('未来内容')
})

it('caps retained text and preserves timing when a long transcript advances', () => {
  const timeline = new MeetingTimeline()
  timeline.update('旧'.repeat(129000), 1000)
  timeline.update('旧'.repeat(129000) + '新'.repeat(500), 100000)
  expect(timeline.text.length).toBe(128000)
  expect(timeline.times.length).toBe(128000)
  expect(timeline.offset).toBe(1500)
  const excerpt = timeline.excerpt(100000, { ...DEFAULT_MEETING_PREFERENCES, lookbackSeconds: 60 })
  expect(excerpt.target).toBe('新'.repeat(500))
  expect(excerpt.preceding.length).toBe(8000)
})

it('keeps the recent excerpt valid when its boundary falls inside a previous command', () => {
  const timeline = new MeetingTimeline()
  timeline.update('背景。解释一下', 1000)
  timeline.update('背景。解释一下刚才这句话。重点内容。', 10000)
  const excerpt = timeline.excerpt(10000, { ...DEFAULT_MEETING_PREFERENCES, recentSeconds: 5 }, undefined, DEFAULT_MEETING_PREFERENCES.keyword)
  expect(excerpt.target).not.toContain('解释一下')
  expect(excerpt.target).toContain(excerpt.recent)
  expect(excerpt.recent).toContain('重点内容')
})


it('keeps an hour of substantial transcript and focuses only on the last minute', () => {
  const timeline = new MeetingTimeline()
  let text = ''
  for (let minute = 0; minute <= 65; minute++) {
    text += `第${minute}分钟。` + '会议资料。'.repeat(180)
    timeline.update(text, minute * 60000)
  }
  const excerpt = timeline.excerpt(65 * 60000, DEFAULT_MEETING_PREFERENCES)
  expect(excerpt.target.startsWith('第5分钟。')).toBe(true)
  expect(excerpt.target.length).toBeGreaterThan(50000)
  expect(excerpt.recent?.startsWith('第64分钟。')).toBe(true)
  expect(excerpt.recent).toContain('第65分钟。')
  expect(excerpt.truncated).toBe(false)
})

it('migrates the old defaults to one hour/one minute and preserves custom preferences', () => {
  localStorage.clear()
  localStorage.setItem('amadeus.meeting.preferences.v2', JSON.stringify({ lookbackSeconds: 120, recentSeconds: 30, presetPrompt: '自定义方向', shortcut: 'Ctrl+KeyJ' }))
  expect(readMeetingPreferences()).toMatchObject({ lookbackSeconds: 3600, recentSeconds: 60, presetPrompt: '自定义方向', shortcut: 'Ctrl+KeyJ' })
  localStorage.setItem(MEETING_PREFERENCES_KEY, JSON.stringify({ lookbackSeconds: 600, recentSeconds: 45 }))
  expect(readMeetingPreferences()).toMatchObject({ lookbackSeconds: 600, recentSeconds: 45 })
  localStorage.clear()
})
