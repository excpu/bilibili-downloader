function createUrlExpiredError(message) {
    const error = new Error(message);
    error.code = 'DOWNLOAD_URL_EXPIRED';
    error.unrecoverable = true;
    error.nonRetriable = true;
    return error;
}

function isUrlRefreshableError(error) {
    const status = error?.statusCode || error?.response?.statusCode;
    return error?.code === 'DOWNLOAD_URL_EXPIRED' || status === 401 || status === 403;
}

module.exports = { createUrlExpiredError, isUrlRefreshableError };
