/**
 * The browser module table supplies React through the injected `require` —
 * every component imports it from here instead of repeating the require.
 */

import type * as ReactNS from 'react'

/** The closure-factory loader injects `require`; declared for typecheck. */
declare const require: (id: string) => unknown

// The loader contract: a closure-factory bundle has no ESM imports; the
// browser module table answers this injected require.
// oxlint-disable-next-line typescript/no-require-imports
export const React: typeof ReactNS = require('react') as typeof ReactNS
export const h = React.createElement
export const useState = React.useState
export const useEffect = React.useEffect
export const useMemo = React.useMemo
export const useCallback = React.useCallback
export const useRef = React.useRef
