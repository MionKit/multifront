// `size` is a named export of the <react> block only (spec 11, "Different exports per target").
import {size} from './OnlyReactExport.ucf' with {framework: 'vue'};

export const doubled = size * 2;
