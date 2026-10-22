/** Id of a `<style>` block's CSS module; names no framework, so React and Svelte share it. */
export function styleId(filename: string, index: number): string {
  return `${filename}?front&type=style&index=${index}&lang.css`;
}

/** `<style module>` class map: a JS module non-Vue targets import as `$style`. */
export function classMapId(filename: string, index: number): string {
  return `${filename}?front&type=style&index=${index}&module&lang.js`;
}
