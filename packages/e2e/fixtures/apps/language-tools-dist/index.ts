import {createUcfLanguagePlugin} from '@multifront/language-tools';

// `typescript` is Volar's augmentation: it typechecks only when the built types keep it.
export const extensions: string[] = createUcfLanguagePlugin().typescript!.extraFileExtensions.map(({extension}) => extension);
