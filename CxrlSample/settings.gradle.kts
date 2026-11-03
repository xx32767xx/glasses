val cxrRepoEnvironment = providers.gradleProperty("cxrRepoEnv")
    .orElse("external")
    .get()
    .lowercase()

require(cxrRepoEnvironment in setOf("internal", "external")) {
    "Invalid cxrRepoEnv '$cxrRepoEnvironment'. Allowed values: internal, external."
}

val cxrRepositoryUrl = when (cxrRepoEnvironment) {
    "internal" -> "https://maven.rokid-inc.com/repository/maven-public/"
    else -> "https://maven.rokid.com/repository/maven-public/"
}

println("CXR-L repository environment: $cxrRepoEnvironment")

pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        exclusiveContent {
            forRepository {
                maven(cxrRepositoryUrl)
            }
            filter {
                includeGroup("com.rokid.cxr")
            }
        }
    }
}

rootProject.name = "CxrlSampleV11"
include(":app")
