import Debug from 'debug';
import got, { type Got, RequestError } from 'got';
import { HttpsProxyAgent } from 'hpagent';
import matter from 'gray-matter';
import pThrottle from 'p-throttle';
import { type Article, type RemoteArticleData, type ArticleStats } from './models.js';

const debug = Debug('devto');
const apiUrl = 'https://dev.to/api';
const paginationLimit = 1000;
const maxRetries = 3;
const retryDelay = 1000; // 1 second delay before retrying

// Proxy configuration from environment variables
const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const httpOptions: any = {};

if (httpsProxy) {
  debug('Using HTTPS proxy: %s', httpsProxy);
  httpOptions.agent = {
    https: new HttpsProxyAgent({
      proxy: httpsProxy,
      rejectUnauthorized: false // Allow self-signed certificates
    })
  };
}

// There's a limit of 10 articles created each 30 seconds by the same user,
// so we need to throttle the API calls in that case.
// The insane type casting is due to typing issues with p-throttle.
const throttledPostForCreate = pThrottle({ limit: 10, interval: 30_500 })(got.post) as any as Got['post'];

// There's a limit of 30 requests each 30 seconds by the same user, so we need to throttle the API calls in that case too.
const throttledPutForUpdate = pThrottle({ limit: 30, interval: 30_500 })(async (url: string, options: any) =>
  got.put(url, options)
) as any as Got['put'];

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function retryRequest(fn: () => Promise<RemoteArticleData>, retries: number): Promise<RemoteArticleData> {
  try {
    return await fn();
  } catch (error) {
    if (retries === 0 || !(error instanceof RequestError && error.response?.statusCode === 429)) {
      throw error;
    }

    debug('Rate limited, retrying in %s ms', retryDelay);
    await delay(retryDelay);
    return retryRequest(fn, retries - 1);
  }
}

export async function getAllArticles(devtoKey: string): Promise<RemoteArticleData[]> {
  try {
    const articles = [];
    let page = 1;
    const getPage = async (page: number) =>
      got<RemoteArticleData[]>(`${apiUrl}/articles/me/all`, {
        ...httpOptions,
        searchParams: { per_page: paginationLimit, page },
        headers: { 'api-key': devtoKey },
        responseType: 'json'
      });

    // Handle pagination
    let newArticles: RemoteArticleData[];
    do {
      debug('Requesting articles (page %s)', page);
      // eslint-disable-next-line no-await-in-loop
      const result = await getPage(page++);
      newArticles = result.body;
      articles.push(...newArticles);
    } while (newArticles.length === paginationLimit);

    debug('Found %s remote article(s)', articles.length);
    return articles;
  } catch (error) {
    if (error instanceof RequestError && error?.response) {
      debug('Debug infos: %O', error.response.body);
    }

    throw error;
  }
}

export async function getLastArticlesStats(devtoKey: string, number: number): Promise<ArticleStats[]> {
  try {
    debug('Requesting stats for %s articles', number);
    debug('API URL: %s', `${apiUrl}/articles/me`);
    const result = await got<RemoteArticleData[]>(`${apiUrl}/articles/me`, {
      ...httpOptions,
      searchParams: { per_page: number || 10 },
      headers: { 'api-key': devtoKey },
      responseType: 'json'
    });
    debug('Received %s articles from API', result.body.length);
    return result.body.map((a) => ({
      date: a.published_at,
      title: a.title,
      views: a.page_views_count,
      reactions: a.positive_reactions_count,
      comments: a.comments_count
    }));
  } catch (error) {
    if (error instanceof RequestError) {
      if (error.code === 'EACCES' || error.code === 'ECONNREFUSED') {
        debug('Network connection error: %s', error.code);
        console.error('\n❌ Network connection error. Check your proxy settings (HTTP_PROXY, HTTPS_PROXY).');
      }

      if (error.response) {
        debug('API request failed with status: %s', error.response.statusCode);
        debug('Response body: %O', error.response.body);
      } else {
        debug('Request error code: %s', error.code);
        debug('Request error message: %s', error.message);
      }
    } else {
      debug('Unexpected error: %s', (error as Error).message);
    }

    throw error;
  }
}

export async function updateRemoteArticle(article: Article, devtoKey: string): Promise<RemoteArticleData> {
  const update = async (): Promise<RemoteArticleData> => {
    try {
      const markdown = matter.stringify(article, article.data, { lineWidth: -1 } as any);
      const { id } = article.data;
      const requestData = { article: { title: article.data.title, body_markdown: markdown } };
      debug('Sending request data: %O', requestData);
      // Throttle API calls in case of article creation or update
      const get = id ? throttledPutForUpdate : throttledPostForCreate;
      const result = await get(`${apiUrl}/articles${id ? `/${id}` : ''}`, {
        ...httpOptions,
        headers: { 'api-key': devtoKey },
        json: requestData,
        responseType: 'json'
      });
      return result.body as unknown as RemoteArticleData;
    } catch (error) {
      if (error instanceof RequestError && error.response) {
        debug('Request failed with status %s', error.response.statusCode);
        debug('Debug infos: %O', error.response.body);
      }

      throw error;
    }
  };

  return retryRequest(update, maxRetries);
}
