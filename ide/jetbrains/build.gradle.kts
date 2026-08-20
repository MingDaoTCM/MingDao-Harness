plugins {
  id("org.jetbrains.kotlin.jvm") version "1.9.24"
  id("org.jetbrains.intellij") version "1.17.4"
}

group = "org.mingdao"
version = "0.5.0"

repositories {
  mavenCentral()
}

intellij {
  version.set("2023.3.7")
  type.set("IC") // Community Edition；PyCharm/WebStorm 等请按目标 IDE 调整
  plugins.set(listOf())
}

kotlin {
  jvmToolchain(17)
}

tasks {
  patchPluginXml {
    sinceBuild.set("233")
    untilBuild.set("")
  }
}
