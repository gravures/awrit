import { test, expect } from 'bun:test';
import { isProbablyURL, normalizeURL } from '../url';

test('isProbablyURL: http/https URLs', () => {
  expect(isProbablyURL('https://example.com')).toBe(true);
  expect(isProbablyURL('http://example.com')).toBe(true);
  expect(isProbablyURL('https://example.com/path')).toBe(true);
  expect(isProbablyURL('https://example.com?query=1')).toBe(true);
});

test('isProbablyURL: other schemes', () => {
  expect(isProbablyURL('file:///home/user')).toBe(true);
  expect(isProbablyURL('ftp://ftp.example.com')).toBe(true);
});

test('isProbablyURL: localhost', () => {
  expect(isProbablyURL('localhost')).toBe(true);
  expect(isProbablyURL('localhost:3000')).toBe(true);
  expect(isProbablyURL('localhost/path')).toBe(true);
});

test('isProbablyURL: IP addresses', () => {
  expect(isProbablyURL('127.0.0.1')).toBe(true);
  expect(isProbablyURL('192.168.1.1')).toBe(true);
  expect(isProbablyURL('127.0.0.1:8080')).toBe(true);
});

test('isProbablyURL: domain names', () => {
  expect(isProbablyURL('example.com')).toBe(true);
  expect(isProbablyURL('sub.example.com')).toBe(true);
  expect(isProbablyURL('example.co.uk')).toBe(true);
  expect(isProbablyURL('example.com/path')).toBe(true);
});

test('isProbablyURL: search queries (not URLs)', () => {
  expect(isProbablyURL('rust async')).toBe(false);
  expect(isProbablyURL('hello world')).toBe(false);
  expect(isProbablyURL('javascript')).toBe(false);
  expect(isProbablyURL('')).toBe(false);
  expect(isProbablyURL('   ')).toBe(false);
});

test('isProbablyURL: edge cases', () => {
  expect(isProbablyURL('example')).toBe(false); // no dot
  expect(isProbablyURL('example.')).toBe(false); // trailing dot only
  expect(isProbablyURL('.com')).toBe(false); // no host
});

test('normalizeURL: adds https://', () => {
  expect(normalizeURL('example.com')).toBe('https://example.com');
  expect(normalizeURL('example.com/path')).toBe('https://example.com/path');
});

test('normalizeURL: preserves scheme', () => {
  expect(normalizeURL('https://example.com')).toBe('https://example.com');
  expect(normalizeURL('http://example.com')).toBe('http://example.com');
  expect(normalizeURL('file:///home')).toBe('file:///home');
});

test('normalizeURL: trims whitespace', () => {
  expect(normalizeURL('  example.com  ')).toBe('https://example.com');
});