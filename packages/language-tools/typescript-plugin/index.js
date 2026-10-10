// tsserver's own Node10 plugin lookup ignores `exports` and skips a module that is not a function.
export {default as 'module.exports'} from '@multifront/language-tools/typescript-plugin';
