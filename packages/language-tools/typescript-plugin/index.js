// tsserver finds plugins with its own Node10 lookup, which ignores `exports`, and skips a module that is not a function.
export {default as 'module.exports'} from '@multifront/language-tools/typescript-plugin';
