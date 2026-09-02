import { describe, expect, it } from 'vitest'
import { parseExtractedFacts } from '../src/extract.ts'

describe('parseExtractedFacts', () => {
  it('parses scope-labeled facts', () => {
    const facts = parseExtractedFacts(
      '<memory-facts>\n- [project] This repo uses pnpm workspaces.\n- [user] User prefers 2-space indent.\n</memory-facts>',
    )
    expect(facts).toEqual([
      { text: 'This repo uses pnpm workspaces.', scope: 'project' },
      { text: 'User prefers 2-space indent.', scope: 'user' },
    ])
  })

  it('defaults unlabeled facts to project', () => {
    const facts = parseExtractedFacts(
      '<memory-facts>\n- The build uses pnpm.\n</memory-facts>',
    )
    expect(facts).toEqual([{ text: 'The build uses pnpm.' }])
    expect(facts[0]?.scope).toBeUndefined() // store.create defaults to project
  })

  it('returns an empty list for an empty frame', () => {
    expect(parseExtractedFacts('<memory-facts>\n</memory-facts>')).toEqual([])
  })

  it('returns an empty list when the frame is missing', () => {
    expect(parseExtractedFacts('no frame here')).toEqual([])
  })

  it('ignores lines without the list prefix and blank lines', () => {
    const facts = parseExtractedFacts(
      '<memory-facts>\n- [project] real fact\nstray line\n\n- [user] another fact\n</memory-facts>',
    )
    expect(facts).toEqual([
      { text: 'real fact', scope: 'project' },
      { text: 'another fact', scope: 'user' },
    ])
  })
})
