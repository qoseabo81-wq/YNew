import axios from "axios";

import {
  wrapper
} from "axios-cookiejar-support";

import {
  CookieJar
} from "tough-cookie";

const jar = new CookieJar();

const axiosClient = axios.create({
  withCredentials: true,
  timeout: 60_000,

  validateStatus: (
    status: number
  ): boolean =>
    status >= 200 &&
    status < 600,

  maxRedirects: 5,
  maxContentLength: Infinity,
  maxBodyLength: Infinity
});

/*
 * axios-cookiejar-support and the installed
 * Axios typings are incompatible here.
 * Runtime wrapper is still valid, so cast
 * only at this boundary.
 */
const client = wrapper(
  axiosClient as any
) as any;

const delay = (
  ms: number
): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(
      resolve,
      Math.max(
        0,
        Number.isFinite(ms)
          ? ms
          : 0
      )
    );
  });

export {
  jar,
  client,
  delay
};
