import './style.css';
import { boot } from './boot';

const isStream = /^\/stream\/?$/.test(window.location.pathname);

void boot(isStream ? () => import('./StreamView.vue') : () => import('./App.vue'));
