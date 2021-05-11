import linguistLanguages from 'linguist-languages'
import { IGraphQLResponseRoot, IQuery } from './schema'
import sourcegraph from 'sourcegraph'

export const isLinguistLanguage = (language: string): language is keyof typeof linguistLanguages =>
    Object.prototype.hasOwnProperty.call(linguistLanguages, language)

export const queryGraphQL = async <T = IQuery>(query: string, variables: object = {}): Promise<T> => {
    const { data, errors }: IGraphQLResponseRoot = await sourcegraph.commands.executeCommand(
        'queryGraphQL',
        query,
        variables
    )
    if (errors && errors.length > 0) {
        throw new Error(errors.map(e => e.message).join('\n'))
    }
    return data as any as T
}

export const parseUri = (uri: URL): { repo: string } => {
    return { repo: uri.hostname + uri.pathname }
}
