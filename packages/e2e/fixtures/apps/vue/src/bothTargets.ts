// A `.ts` importer has no default framework: the attributes pick both targets of one file.
export {default as VueCounter} from '../../../components/Counter.ucf' with {framework: 'vue'};
export {default as ReactCounter} from '../../../components/Counter.ucf' with {framework: 'react'};
