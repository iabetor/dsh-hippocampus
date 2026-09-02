/** CSS-module import declarations for the browser bundle. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
