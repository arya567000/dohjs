const dnsPacket = require('dns-packet');
const https = require('https');
const http = require('http');

/**
 * Allowed request methods for sending DNS over HTTPS requests.
 * <br>
 * Allowed method are "GET" and "POST"
 * @type {array}
 */
const ALLOWED_REQUEST_METHODS = ["GET", "POST"];

/**
 * Custom error class to be thrown when someone tries to send a DoH request
 * with a request method other than "GET" or "POST"
 */
class MethodNotAllowedError extends Error {
  constructor(message = "", ...params) {
    super();
    this.name = 'MethodNotAllowedError';
    this.message = message;
  }
}

/**
 * Check if a request method is allowed
 * @param method {string} the request method to test
 * @returns {boolean} If `method` is "GET" or "POST", return true; return false otherwise.
 */
function isMethodAllowed(method) {
  return ALLOWED_REQUEST_METHODS.indexOf(method) !== -1;
}

/**
 * A super lame DNS over HTTPS stub resolver
 */
class DohResolver {
  /**
   * Creates a new DoH resolver
   * @param nameserver_url {string} The URL we're going to be sending DNS requests to
   * @example
// import the required stuff
const {DohResolver} = require('dohjs');

// create your resolver
const resolver = new DohResolver('https://dns.google/dns-query')

// lookup the A records for example.com
// print out the answer data
resolver.query('example.com', 'A')
  .then(response => {
    response.answer.forEach(ans => console.log(ans.data));
  })
  .catch(err => console.error(err));
  */
  constructor(nameserver_url) {
    this.nameserver_url = nameserver_url;
  }

  /**
   * Perform a DNS lookup for the given query name and type.
   *
   * @param qname {string} the domain name to query for (e.g. example.com)
   * @param qtype {string} the type of record we're looking for (e.g. A, AAAA, TXT, MX)
   * @param method {string} Must be either "GET" or "POST"
   * @param headers {object} define HTTP headers to use in the DNS query
   * <br>
   * <b><i>IMPORTANT: If you don't provide the "Accept: application/dns-message" header, you probably won't get the response you're hoping for.
   * See [RFC 8484 examples](https://tools.ietf.org/html/rfc8484#section-4.1.1) for examples of HTTPS headers for both GET and POST requests.</i></b>
   * @throws {MethodNotAllowedError} If the method is not allowed (i.e. if it's not "GET" or "POST"), a MethodNotAllowedError will be thrown.
   * @returns {Promise<object>} The DNS response received
   */
  query(qname, qtype='A', method='POST', headers=null) {
    return new Promise((resolve, reject) => {
      if (!isMethodAllowed(method)) {
        return reject(new MethodNotAllowedError(`Request method ${method} not allowed. Must be either 'GET' or 'POST'`))
      }
      let dnsMessage = makeQuery(qname, qtype);
      sendDohMsg(dnsMessage, this.nameserver_url, method, headers)
        .then(resolve)
        .catch(reject)
    });
  }
}

/**
 * Make a DNS query message of type {@link object} (see [dns-packet]{@link https://github.com/mafintosh/dns-packet}). Use this before calling {@link sendDohMsg}
 * <br>
 * The recursion desired flag will be set, and the ID in the header will be set to zero, per the RFC ([section 4.1](https://tools.ietf.org/html/rfc8484#section-4.1)).
 * @param qname {string} the domain name to put in the query message (e.g. example.com)
 * @param qtype {string} the query type to put in the query message (e.g. A, AAAA, DS, DNSKEY)
 * @returns {object} The DNS query message
 * @example
// imports
const {makeQuery} = require('dohjs');

// create a query message
const msg = makeQuery('example.com', 'TXT');

// print it out to the console
console.log(msg);
// -> { type: 'query',
// ->  id: 0,
// ->  flags: 256,
// ->  questions: [ { type: 'TXT', name: 'example.com' } ] }
 */
function makeQuery(qname, qtype='A') {
  return {
    type: 'query',
    /*
    In order to maximize HTTP cache friendliness, DoH clients using media
   formats that include the ID field from the DNS message header, such
   as "application/dns-message", SHOULD use a DNS ID of 0 in every DNS
   request.

   https://tools.ietf.org/html/rfc8484#section-4.1
     */
    id: 0,
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{
      type: qtype,
      name: qname,
    }]
  };
}

/**
 * Send a DNS message over HTTPS to `url` using the given request method
 *
 * @param packet {object} the DNS message to send
 * @param url {string} the url to send the DNS message to
 * @param method {string} the request method to use ("GET" or "POST")
 * @param headers {object} headers to send in the DNS request. The default headers for GET requests are
 * @returns {Promise<object>} the response (if we got any)
 * @example
// imports
const {makeQuery, sendDohMsg} = require('dohjs');

const url = 'https://cloudflare-dns.com/dns-query';
const method = 'GET';

// create a query message
let msg = makeQuery('example.com', 'TXT');

// send it and print out the response to the console
sendDohMsg(msg, url, method)
.then(response => response.answers.forEach(ans => console.log(ans.data.toString())))
.catch(console.error);
 */
function sendDohMsg(packet, url, method, headers) {
  return new Promise((resolve, reject) => {
    const transportModule = url.startsWith('https://') ? https : http;
    const buf = dnsPacket.encode(packet);
    let requestOptions;
    if (!headers) {
      headers = {
        'Accept': 'application/dns-message',
        'User-Agent': 'dohjs/0.2.0'
      };
    }
    if (method === 'POST') {
      Object.assign(headers, {
        'Content-Type': 'application/dns-message',
        'Content-Length': buf.length
      });
    } else if (method === 'GET') {
      const dnsQueryParam = buf.toString('base64').toString('utf-8').replace(/=/g, '');
      url = `${url}?dns=${dnsQueryParam}`;
    }
    url = new URL(url);
    requestOptions = {
      method: method,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: headers
    };
    let data;
    const request = transportModule.request(requestOptions, (response) => {
      response.on('data', (d) => {
        if (!data) {
          data = d;
        } else {
          data = Buffer.concat([data, d]);
        }
      });
      response.on('end', () => {
        const decoded = dnsPacket.decode(data);
        resolve(decoded);
      });
    });
    request.on('error', (err) => {
      request.abort();
      return reject(err);
    });
    if (method === 'POST') {
      request.write(buf)
    }
    request.end()
  });
}

const dohjs = {
  sendDohMsg: sendDohMsg,
  DohResolver: DohResolver,
  makeQuery: makeQuery,
  MethodNotAllowedError: MethodNotAllowedError,
  isMethodAllowed: isMethodAllowed
};

module.exports = dohjs;
