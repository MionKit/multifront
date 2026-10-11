import {createSSRApp} from 'vue';
import {renderToString} from 'vue/server-renderer';
import App from './App.vue';

export function render(): Promise<string> {
  return renderToString(createSSRApp(App));
}
