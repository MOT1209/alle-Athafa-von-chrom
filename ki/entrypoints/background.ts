import { defineBackground } from 'wxt/utils/define-background';
import { bootstrapBackground } from '../src/background/runtime';

export default defineBackground(() => {
  bootstrapBackground();
});
