import { initLocale } from './i18n';
import './styles.css';
import './styles-dataflow.css';

// Page modules translate their text when they are imported, so the language and its catalog
// must be ready before anything else loads.
void initLocale().then(() => import('./bootstrap'));
