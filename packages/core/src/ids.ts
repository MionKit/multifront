/** The CSS module of one `<style>` block; it names no framework, so React and Svelte share it. */
export function styleId(filename: string, index: number): string {
  return `${filename}?ucf&type=style&index=${index}&lang.css`;
}
