// Small caches for data many screens need (categories, members, lists).
import { api } from './api.js';

const cache = new Map();
function cached(key, url) {
  return (fresh = false) => {
    if (fresh || !cache.has(key)) cache.set(key, api.get(url).catch((e) => { cache.delete(key); throw e; }));
    return cache.get(key);
  };
}
export const getCategories = cached('categories', '/api/categories');
export const getMembers = cached('members', '/api/household/members');
export const getLists = cached('lists', '/api/lists');
export const invalidate = (...keys) => keys.forEach((k) => cache.delete(k));
