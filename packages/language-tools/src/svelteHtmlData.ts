import type {IAttributeData, IHTMLDataProvider, ITagData} from 'vscode-html-languageservice';

/** Valid only at the top level of the markup. */
export const META_ELEMENTS: ReadonlySet<string> = new Set([
  'svelte:window',
  'svelte:document',
  'svelte:body',
  'svelte:head',
  'svelte:options',
]);

const attributes = (described: Record<string, string>): IAttributeData[] =>
  Object.entries(described).map(([name, description]) => ({name, description}));

const SVELTE_ELEMENTS: ITagData[] = [
  {name: 'svelte:window', description: 'Adds event listeners and bindings to the `window` object.', attributes: []},
  {name: 'svelte:document', description: 'Adds event listeners and bindings to `document`.', attributes: []},
  {name: 'svelte:body', description: 'Adds event listeners to `document.body`.', attributes: []},
  {name: 'svelte:head', description: 'Inserts elements into `document.head`.', attributes: []},
  {
    name: 'svelte:element',
    description: 'Renders the element named by `this`.',
    attributes: attributes({this: 'The tag name to render.'}),
  },
  {name: 'svelte:boundary', description: 'Guards its children against errors while rendering.', attributes: []},
  {name: 'svelte:options', description: 'Compiler options for this component.', attributes: []},
];

const MEDIA_BINDS = attributes({
  'bind:currentTime': 'The current playback time, in seconds.',
  'bind:duration': 'The length of the media, in seconds (read-only).',
  'bind:paused': 'Whether the media is paused.',
  'bind:volume': 'The volume, from 0 to 1.',
  'bind:muted': 'Whether the media is muted.',
  'bind:playbackRate': 'The playback speed.',
});

const BINDS_BY_TAG: Record<string, IAttributeData[]> = {
  input: attributes({
    'bind:value': 'Two-way binding of the input value.',
    'bind:checked': 'Two-way binding of a checkbox state.',
    'bind:group': 'Binds a group of radio or checkbox inputs to one value.',
    'bind:files': 'The selected files of a file input.',
    'bind:indeterminate': 'The indeterminate state of a checkbox.',
  }),
  textarea: attributes({'bind:value': 'Two-way binding of the text.'}),
  select: attributes({'bind:value': 'Two-way binding of the selected option.'}),
  details: attributes({'bind:open': 'Whether the details are open.'}),
  audio: MEDIA_BINDS,
  video: MEDIA_BINDS,
  img: attributes({
    'bind:naturalWidth': 'The image width before scaling (read-only).',
    'bind:naturalHeight': 'The image height before scaling (read-only).',
  }),
};

const GLOBAL_ATTRIBUTES: IAttributeData[] = attributes({
  'bind:': 'Binds a property both ways.',
  'class:': 'Toggles a class with a condition.',
  'style:': 'Sets one style property.',
  'use:': 'Runs an action on the element.',
  'transition:': 'Plays a transition when the element enters or leaves.',
  'in:': 'Plays a transition when the element enters.',
  'out:': 'Plays a transition when the element leaves.',
  'animate:': 'Animates the element when a keyed each block reorders.',
  'bind:this': 'A reference to the DOM element.',
  'bind:clientWidth': 'The element width without borders (read-only).',
  'bind:clientHeight': 'The element height without borders (read-only).',
  'bind:offsetWidth': 'The element width with borders (read-only).',
  'bind:offsetHeight': 'The element height with borders (read-only).',
  'bind:innerHTML': 'The HTML of a `contenteditable` element.',
  'bind:innerText': 'The text of a `contenteditable` element.',
  'bind:textContent': 'The text content of a `contenteditable` element.',
});

/** Svelte's elements and directives, beside the HTML service's default data. */
export const svelteHtmlData: IHTMLDataProvider = {
  getId: () => 'svelte',
  isApplicable: () => true,
  provideTags: () => SVELTE_ELEMENTS,
  provideAttributes: (tag) => [
    ...(SVELTE_ELEMENTS.find(({name}) => name === tag)?.attributes ?? []),
    ...(BINDS_BY_TAG[tag] ?? []),
    ...GLOBAL_ATTRIBUTES,
  ],
  provideValues: () => [],
};
